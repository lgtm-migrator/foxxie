import type { Word } from '#lib/database';
import { GuildSettings } from '#lib/database';
import { LanguageKeys } from '#lib/i18n';
import { IncomingType, ModerationBitField, ModerationFlagBits, ModerationHardActionFlags, OutgoingWordFilterPayload, OutputType } from '#lib/structures';
import { EventArgs, Events, GuildMessage } from '#lib/types';
import { Colors } from '#utils/constants';
import { deleteMessage, getModeration, isModerator, isSendableChannel, sendTemporaryMessage } from '#utils/Discord';
import type { SendOptions } from '#utils/moderation';
import { floatPromise } from '#utils/util';
import type { TFunction } from '@foxxie/i18n';
import { isDev, seconds } from '@ruffpuff/utilities';
import { ApplyOptions } from '@sapphire/decorators';
import { Listener, ListenerOptions } from '@sapphire/framework';
import { Message, MessageEmbed } from 'discord.js';

@ApplyOptions<ListenerOptions>({
    event: Events.UserMessage,
    enabled: !isDev()
})
export class UserListener extends Listener<Events.UserMessage> {
    public async run(...[msg]: EventArgs<Events.UserMessage>): Promise<void> {
        const shouldRun = this.shouldRun(msg);
        if (!shouldRun) return;

        const [regex, words, t] = await this.container.db.guilds.acquire(msg.guild.id, settings => [
            settings.wordFilterRegExp,
            settings[GuildSettings.Moderation.Words],
            settings.getLanguage()
        ]);

        if (regex === null) return;

        const processed = await this.container.workers.send({ content: msg.content, regex, type: IncomingType.RunWordFilter }, 500);
        if (processed.type !== OutputType.FilterMatch) return;

        const sanitized = this.sanitize(processed.match!);
        const found = words.find(word => word.word.toLowerCase() === sanitized);
        if (!found) return;

        const bitfield = new ModerationBitField(found.softPunish);
        await this.processSoftPunishment(msg, t, bitfield, processed);

        await this.processHardPunishment(msg, t, found);
    }

    private async processHardPunishment(msg: GuildMessage, t: TFunction, found: Word) {
        const [action, duration] = [found.hardPunish, found.hardPunishDuration];
        switch (action) {
            case ModerationHardActionFlags.Warning:
                await this.onWarning(msg, t);
                break;
            case ModerationHardActionFlags.Kick:
                await this.onKick(msg, t);
                break;
            case ModerationHardActionFlags.Mute:
                await this.onMute(msg, t, duration);
                break;
            case ModerationHardActionFlags.SoftBan:
                await this.onSoftBan(msg, t);
                break;
            case ModerationHardActionFlags.Ban:
                await this.onBan(msg, t, duration);
                break;
        }
    }

    private async onWarning(msg: GuildMessage, t: TFunction) {
        return getModeration(msg.guild).actions.warn(
            {
                userId: msg.author.id,
                moderatorId: process.env.CLIENT_ID,
                channelId: msg.channel.id,
                reason: t(LanguageKeys.Automod.WordReason)
            },
            await this.getDmOptions(msg)
        );
    }

    private async onKick(msg: GuildMessage, t: TFunction) {
        await this.container.redis!.pinsertex(`guild:${msg.guild.id}:kick:${msg.author.id}`, seconds(20), '');
        return getModeration(msg.guild).actions.kick(
            {
                userId: msg.author.id,
                moderatorId: process.env.CLIENT_ID,
                channelId: msg.channel.id,
                reason: t(LanguageKeys.Automod.WordReason)
            },
            await this.getDmOptions(msg)
        );
    }

    private async onSoftBan(msg: GuildMessage, t: TFunction) {
        await this.container.redis!.pinsertex(`guild:${msg.guild.id}:ban:${msg.author.id}`, seconds(20), '');
        await this.container.redis!.pinsertex(`guild:${msg.guild.id}:unban:${msg.author.id}`, seconds(20), '');
        return getModeration(msg.guild).actions.softban(
            {
                userId: msg.author.id,
                moderatorId: process.env.CLIENT_ID,
                channelId: msg.channel.id,
                reason: t(LanguageKeys.Automod.WordReason)
            },
            1,
            await this.getDmOptions(msg)
        );
    }

    private async onBan(msg: GuildMessage, t: TFunction, duration: number | null) {
        await this.container.redis!.pinsertex(`guild:${msg.guild.id}:ban:${msg.author.id}`, seconds(20), '');
        return getModeration(msg.guild).actions.ban(
            {
                userId: msg.author.id,
                moderatorId: process.env.CLIENT_ID,
                channelId: msg.channel.id,
                reason: t(LanguageKeys.Automod.WordReason),
                duration
            },
            1,
            await this.getDmOptions(msg)
        );
    }

    private async onMute(msg: GuildMessage, t: TFunction, duration: number | null) {
        const roleId = await this.container.db.guilds.acquire(msg.guild.id, GuildSettings.Roles.Muted);
        if (!roleId) return;

        return getModeration(msg.guild).actions.mute(
            {
                userId: msg.author.id,
                moderatorId: process.env.CLIENT_ID,
                channelId: msg.channel.id,
                reason: t(LanguageKeys.Automod.WordReason),
                duration,
                extraData: { roleId }
            },
            await this.getDmOptions(msg)
        );
    }

    private async processSoftPunishment(msg: GuildMessage, t: TFunction, bitfield: ModerationBitField, processed: OutgoingWordFilterPayload) {
        if (bitfield.has(ModerationFlagBits.Delete)) {
            await floatPromise(this.onDelete(msg));
        }

        if (bitfield.has(ModerationFlagBits.Alert) && isSendableChannel(msg.channel)) {
            await floatPromise(this.onAlert(msg, t));
        }

        if (bitfield.has(ModerationFlagBits.Log)) {
            this.onLog(msg, t, processed);
        }
    }

    private onDelete(msg: GuildMessage): Promise<Message | void | unknown> {
        return deleteMessage(msg);
    }

    private onAlert(msg: GuildMessage, t: TFunction): Promise<Message> {
        return sendTemporaryMessage(msg, t(LanguageKeys.Automod.WordAlert, { author: msg.author.toString() }));
    }

    private onLog(msg: GuildMessage, t: TFunction, processed: OutgoingWordFilterPayload) {
        this.container.client.emit(Events.GuildMessageLog, msg.guild, GuildSettings.Channels.Logs.FilterWords, () =>
            new MessageEmbed()
                .setColor(Colors.Red)
                .setAuthor({ name: t(LanguageKeys.Guilds.Logs.ActionFilterWords), iconURL: msg.member.displayAvatarURL({ dynamic: true }) })
                .setDescription(
                    [
                        t(LanguageKeys.Guilds.Logs.ArgsUser, { user: msg.author }),
                        t(LanguageKeys.Guilds.Logs.ArgsChannel, { channel: msg.channel }),
                        t(LanguageKeys.Guilds.Logs.ArgsMessage, { content: processed.highlighted })
                    ].join('\n')
                )
                .setTimestamp()
        );
    }

    private shouldRun(msg: GuildMessage) {
        return !isModerator(msg.member);
    }

    private async getDmOptions(msg: GuildMessage): Promise<SendOptions> {
        const shouldSend = await this.container.db.guilds.acquire(msg.guild.id, GuildSettings.Moderation.Dm);
        return { send: shouldSend };
    }

    private sanitize(str: string) {
        return str
            .replace(/(@|4)/g, 'a')
            .replace(/8/g, 'b')
            .replace(/3/g, 'e')
            .replace(/6/g, 'g')
            .replace(/1/g, 'i')
            .replace(/7/g, 'l')
            .replace(/0/g, 'o')
            .replace(/5/g, 's')
            .replace(/7/g, 't')
            .replace(/\W/g, '')
            .toLowerCase();
    }
}
