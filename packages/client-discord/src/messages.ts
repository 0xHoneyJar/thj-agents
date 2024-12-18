import {
    composeContext,
    Content,
    elizaLogger,
    generateMessageResponse,
    generateShouldRespond,
    getEmbeddingZeroVector,
    HandlerCallback,
    IAgentRuntime,
    IBrowserService,
    ISpeechService,
    IVideoService,
    Media,
    Memory,
    ModelClass,
    ServiceType,
    State,
    stringToUuid,
    UUID,
} from "@ai16z/eliza";
import {
    ChannelType,
    Client,
    Message as DiscordMessage,
    TextChannel,
} from "discord.js";
import { AttachmentManager } from "./attachments.ts";
import {
    discordMessageHandlerTemplate,
    discordShouldRespondTemplate,
} from "./templates.ts";
import { canSendMessage, sendMessageInChunks } from "./utils.ts";
import { VoiceManager } from "./voice.ts";

export type InterestChannels = {
    [key: string]: {
        lastMessageSent: number;
        messages: { userId: UUID; userName: string; content: Content }[];
    };
};

interface DiscordClientConfig {
    shouldIgnoreBotMessages?: boolean;
    shouldIgnoreDirectMessages?: boolean;
    allowedRoles?: string[];
    primaryChannelIds?: string[];
    blockedChannelIds?: string[];
}

export class MessageManager {
    private client: Client;
    private runtime: IAgentRuntime;
    private attachmentManager: AttachmentManager;
    private interestChannels: InterestChannels = {};
    private discordClient: any;
    private voiceManager: VoiceManager;

    constructor(discordClient: any, voiceManager: VoiceManager) {
        this.client = discordClient.client;
        this.voiceManager = voiceManager;
        this.discordClient = discordClient;
        this.runtime = discordClient.runtime;
        this.attachmentManager = new AttachmentManager(this.runtime);
    }

    async handleMessage(message: DiscordMessage) {
        if (message.interaction || message.author.id === this.client.user?.id)
            return;

        const config = this.runtime.character.clientConfig
            ?.discord as DiscordClientConfig;
        const channelId = message.channel.id;

        // Early check for response permissions - but continue processing for memory
        const canRespond = !config.blockedChannelIds.includes(channelId);

        try {
            // Process message and store memory regardless of response permissions
            const { processedContent, attachments } =
                await this.processMessageMedia(message);

            const audioAttachments = message.attachments.filter((attachment) =>
                attachment.contentType?.startsWith("audio/")
            );
            if (audioAttachments.size > 0) {
                const processedAudioAttachments =
                    await this.attachmentManager.processAttachments(
                        audioAttachments
                    );
                attachments.push(...processedAudioAttachments);
            }

            const roomId = stringToUuid(channelId + "-" + this.runtime.agentId);
            const userIdUUID = stringToUuid(message.author.id);

            await this.runtime.ensureConnection(
                userIdUUID,
                roomId,
                message.author.username,
                message.author.displayName,
                "discord"
            );

            const messageId = stringToUuid(
                message.id + "-" + this.runtime.agentId
            );

            const userMessage = {
                content: {
                    text: processedContent,
                    attachments: attachments,
                    source: "discord",
                    url: message.url,
                    user: message.author.id,
                    userName: message.author.username,
                    roles:
                        message.member?.roles.cache.map((role) => ({
                            id: role.id,
                            name: role.name,
                            color: role.color,
                        })) || [],
                    inReplyTo: message.reference?.messageId
                        ? stringToUuid(
                              message.reference.messageId +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
                    channelInfo: {
                        id: message.channel.id,
                        name:
                            "name" in message.channel
                                ? message.channel.name
                                : "DM",
                        type: message.channel.type,
                        ...(message.channel.type !== ChannelType.DM &&
                            message.guild && {
                                isThread:
                                    "isThread" in message.channel
                                        ? message.channel.isThread()
                                        : false,
                                // For threads, parent is the channel. For channels, parent is the category
                                parentId:
                                    (message.channel as TextChannel).parentId ||
                                    undefined,
                                parentName:
                                    (message.channel as TextChannel).parent
                                        ?.name || undefined,
                                // Get category info from guild channels cache
                                categoryId:
                                    message.guild.channels.cache.find(
                                        (c) =>
                                            c.type ===
                                                ChannelType.GuildCategory &&
                                            (c.id ===
                                                (message.channel as TextChannel)
                                                    .parentId ||
                                                c.id ===
                                                    (
                                                        message.channel as TextChannel
                                                    ).parent?.parentId)
                                    )?.id || undefined,
                                categoryName:
                                    message.guild.channels.cache.find(
                                        (c) =>
                                            c.type ===
                                                ChannelType.GuildCategory &&
                                            (c.id ===
                                                (message.channel as TextChannel)
                                                    .parentId ||
                                                c.id ===
                                                    (
                                                        message.channel as TextChannel
                                                    ).parent?.parentId)
                                    )?.name || undefined,
                            }),
                    },
                },
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                roomId,
            };

            const memory: Memory = {
                id: stringToUuid(message.id + "-" + this.runtime.agentId),
                ...userMessage,
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                roomId,
                content: {
                    text: processedContent,
                    attachments: attachments,
                    source: "discord",
                    url: message.url,
                    user: message.author.id,
                    userName: message.author.username,
                    roles:
                        message.member?.roles.cache.map((role) => ({
                            id: role.id,
                            name: role.name,
                            color: role.color,
                        })) || [],
                    inReplyTo: message.reference?.messageId
                        ? stringToUuid(
                              message.reference.messageId +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
                    channelInfo: {
                        id: message.channel.id,
                        name:
                            "name" in message.channel
                                ? message.channel.name
                                : "DM",
                        type: message.channel.type,
                        ...(message.channel.type !== ChannelType.DM &&
                            message.guild && {
                                isThread:
                                    "isThread" in message.channel
                                        ? message.channel.isThread()
                                        : false,
                                // For threads, parent is the channel. For channels, parent is the category
                                parentId:
                                    (message.channel as TextChannel).parentId ||
                                    undefined,
                                parentName:
                                    (message.channel as TextChannel).parent
                                        ?.name || undefined,
                                // Get category info from guild channels cache
                                categoryId:
                                    message.guild.channels.cache.find(
                                        (c) =>
                                            c.type ===
                                                ChannelType.GuildCategory &&
                                            (c.id ===
                                                (message.channel as TextChannel)
                                                    .parentId ||
                                                c.id ===
                                                    (
                                                        message.channel as TextChannel
                                                    ).parent?.parentId)
                                    )?.id || undefined,
                                categoryName:
                                    message.guild.channels.cache.find(
                                        (c) =>
                                            c.type ===
                                                ChannelType.GuildCategory &&
                                            (c.id ===
                                                (message.channel as TextChannel)
                                                    .parentId ||
                                                c.id ===
                                                    (
                                                        message.channel as TextChannel
                                                    ).parent?.parentId)
                                    )?.name || undefined,
                            }),
                    },
                },
                createdAt: message.createdTimestamp,
                embedding: getEmbeddingZeroVector(),
            };

            if (memory.content.text) {
                await this.runtime.messageManager.addEmbeddingToMemory(memory);
                await this.runtime.messageManager.createMemory(memory);
            }

            let state = await this.runtime.composeState(userMessage, {
                discordClient: this.client,
                discordMessage: message,
                agentName:
                    this.runtime.character.name ||
                    this.client.user?.displayName,
                roomType: config?.primaryChannelIds?.includes(
                    message.channel.id
                )
                    ? "primary"
                    : "public",
            });

            const canSendResult = canSendMessage(message.channel);
            if (!canSendResult.canSend) {
                return elizaLogger.warn(
                    `Cannot send message to channel ${message.channel}`,
                    canSendResult
                );
            }

            let shouldIgnore = false;
            let shouldRespond = true;

            if (config?.blockedChannelIds?.length) {
                const channelId = message.channel.id;
                if (config.blockedChannelIds.includes(channelId)) {
                    elizaLogger.debug(
                        `Ignoring message from non-allowed channel ${channelId}`
                    );
                    shouldRespond = false;
                }
            }

            if (!shouldIgnore) {
                shouldIgnore = await this._shouldIgnore(message);
            }

            if (shouldIgnore) return;

            const hasInterest = this._checkInterest(channelId);

            const agentUserState =
                await this.runtime.databaseAdapter.getParticipantUserState(
                    roomId,
                    this.runtime.agentId
                );

            if (
                agentUserState === "MUTED" &&
                !message.mentions.has(this.client.user.id) &&
                !hasInterest
            ) {
                console.log("Ignoring muted room");
                // Ignore muted rooms unless explicitly mentioned
                return;
            }

            if (agentUserState === "FOLLOWED") {
                shouldRespond = true; // Always respond in followed rooms
            } else if (
                (!shouldRespond && hasInterest) ||
                (shouldRespond && !hasInterest)
            ) {
                shouldRespond = await this._shouldRespond(message, state);
            }

            if (shouldRespond) {
                const context = composeContext({
                    state,
                    template:
                        this.runtime.character.templates
                            ?.discordMessageHandlerTemplate ||
                        discordMessageHandlerTemplate,
                });

                const responseContent = await this._generateResponse(
                    memory,
                    state,
                    context
                );

                responseContent.text = responseContent.text?.trim();
                responseContent.inReplyTo = stringToUuid(
                    message.id + "-" + this.runtime.agentId
                );

                if (!responseContent.text) {
                    return;
                }

                const callback: HandlerCallback = async (
                    content: Content,
                    files: any[],
                    options?: { targetChannelId?: string }
                ) => {
                    try {
                        if (message.id && !content.inReplyTo) {
                            content.inReplyTo = stringToUuid(
                                message.id + "-" + this.runtime.agentId
                            );
                        }

                        // Get target channel
                        const targetChannel = options?.targetChannelId
                            ? ((await this.client.channels.fetch(
                                  options.targetChannelId
                              )) as TextChannel)
                            : (message.channel as TextChannel);

                        const messages = await sendMessageInChunks(
                            targetChannel,
                            content.text,
                            message.id,
                            files
                        );

                        const memories: Memory[] = [];
                        for (const m of messages) {
                            let action = content.action;
                            // If there's only one message or it's the last message, keep the original action
                            // For multiple messages, set all but the last to 'CONTINUE'
                            if (
                                messages.length > 1 &&
                                m !== messages[messages.length - 1]
                            ) {
                                action = "CONTINUE";
                            }

                            const memory: Memory = {
                                id: stringToUuid(
                                    m.id + "-" + this.runtime.agentId
                                ),
                                userId: this.runtime.agentId,
                                agentId: this.runtime.agentId,
                                content: {
                                    ...content,
                                    action,
                                    inReplyTo: messageId,
                                    url: m.url,
                                },
                                roomId,
                                embedding: getEmbeddingZeroVector(),
                                createdAt: m.createdTimestamp,
                            };
                            memories.push(memory);
                        }
                        for (const m of memories) {
                            await this.runtime.messageManager.createMemory(m);
                        }
                        return memories;
                    } catch (error) {
                        console.error("Error sending message:", error);
                        return [];
                    }
                };

                const responseMessages = await callback(responseContent);

                state = await this.runtime.updateRecentMessageState(state);

                // If agent has allowed response channels, check if message is in them and ignore if not. This still allows agent to process messages in other channels
                if (config?.blockedChannelIds?.length) {
                    const channelId = message.channel.id;

                    if (config.blockedChannelIds.includes(channelId)) {
                        elizaLogger.debug(
                            `Ignoring message from blocked channel ${channelId}`
                        );
                        return;
                    }
                }

                await this.runtime.processActions(
                    memory,
                    responseMessages,
                    state,
                    callback
                );
            }

            // Always evaluate the message even if we don't respond
            await this.runtime.evaluate(
                memory,
                state,
                canRespond && shouldRespond
            );
        } catch (error) {
            console.error("Error handling message:", error);
            if (message.channel.type === ChannelType.GuildVoice) {
                // For voice channels, use text-to-speech for the error message
                const errorMessage = "Sorry, I had a glitch. What was that?";

                const speechService = this.runtime.getService<ISpeechService>(
                    ServiceType.SPEECH_GENERATION
                );
                if (!speechService) {
                    throw new Error("Speech generation service not found");
                }

                const audioStream = await speechService.generate(
                    this.runtime,
                    errorMessage
                );
                await this.voiceManager.playAudioStream(
                    this.runtime.agentId,
                    audioStream
                );
            } else {
                // For text channels, send the error message
                console.error("Error sending message:", error);
            }
        }
    }

    async cacheMessages(channel: TextChannel, count: number = 20) {
        const messages = await channel.messages.fetch({ limit: count });

        // TODO: This is throwing an error but seems to work?
        for (const [_, message] of messages) {
            await this.handleMessage(message);
        }
    }

    async processMessageMedia(
        message: DiscordMessage
    ): Promise<{ processedContent: string; attachments: Media[] }> {
        let processedContent = message.content;

        let attachments: Media[] = [];

        // Process code blocks in the message content
        const codeBlockRegex = /```([\s\S]*?)```/g;
        let match;
        while ((match = codeBlockRegex.exec(processedContent))) {
            const codeBlock = match[1];
            const lines = codeBlock.split("\n");
            const title = lines[0];
            const description = lines.slice(0, 3).join("\n");
            const attachmentId =
                `code-${Date.now()}-${Math.floor(Math.random() * 1000)}`.slice(
                    -5
                );
            attachments.push({
                id: attachmentId,
                url: "",
                title: title || "Code Block",
                source: "Code",
                description: description,
                text: codeBlock,
            });
            processedContent = processedContent.replace(
                match[0],
                `Code Block (${attachmentId})`
            );
        }

        // Process message attachments
        if (message.attachments.size > 0) {
            attachments = await this.attachmentManager.processAttachments(
                message.attachments
            );
        }

        // TODO: Move to attachments manager
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = processedContent.match(urlRegex) || [];

        for (const url of urls) {
            if (
                this.runtime
                    .getService<IVideoService>(ServiceType.VIDEO)
                    ?.isVideoUrl(url)
            ) {
                const videoService = this.runtime.getService<IVideoService>(
                    ServiceType.VIDEO
                );
                if (!videoService) {
                    throw new Error("Video service not found");
                }
                const videoInfo = await videoService.processVideo(
                    url,
                    this.runtime
                );

                attachments.push({
                    id: `youtube-${Date.now()}`,
                    url: url,
                    title: videoInfo.title,
                    source: "YouTube",
                    description: videoInfo.description,
                    text: videoInfo.text,
                });
            } else {
                const browserService = this.runtime.getService<IBrowserService>(
                    ServiceType.BROWSER
                );
                if (!browserService) {
                    throw new Error("Browser service not found");
                }

                const { title, description: summary } =
                    await browserService.getPageContent(url, this.runtime);

                attachments.push({
                    id: `webpage-${Date.now()}`,
                    url: url,
                    title: title || "Web Page",
                    source: "Web",
                    description: summary,
                    text: summary,
                });
            }
        }

        return { processedContent, attachments };
    }

    private _checkInterest(channelId: string): boolean {
        return !!this.interestChannels[channelId];
    }

    private async _shouldIgnore(message: DiscordMessage): Promise<boolean> {
        // if the message is from us, ignore
        if (message.author.id === this.client.user?.id) return true;
        let messageContent = message.content.toLowerCase();

        // Replace the bot's @ping with the character name
        const botMention = `<@!?${this.client.user?.id}>`;
        messageContent = messageContent.replace(
            new RegExp(botMention, "gi"),
            this.runtime.character.name.toLowerCase()
        );

        // Replace the bot's username with the character name
        const botUsername = this.client.user?.username.toLowerCase();
        messageContent = messageContent.replace(
            new RegExp(`\\b${botUsername}\\b`, "g"),
            this.runtime.character.name.toLowerCase()
        );

        // strip all special characters
        messageContent = messageContent.replace(/[^a-zA-Z0-9\s]/g, "");

        // short responses where ruby should stop talking and disengage unless mentioned again
        const loseInterestWords = [
            "shut up",
            "stop",
            "please shut up",
            "shut up please",
            "dont talk",
            "silence",
            "stop talking",
            "be quiet",
            "hush",
            "wtf",
            "chill",
            "stfu",
            "stupid bot",
            "dumb bot",
            "stop responding",
            "god damn it",
            "god damn",
            "goddamnit",
            "can you not",
            "can you stop",
            "be quiet",
            "hate you",
            "hate this",
            "fuck up",
        ];
        if (
            messageContent.length < 100 &&
            loseInterestWords.some((word) => messageContent.includes(word))
        ) {
            delete this.interestChannels[message.channelId];
            return true;
        }

        // If we're not interested in the channel and it's a short message, ignore it
        if (
            messageContent.length < 10 &&
            !this.interestChannels[message.channelId]
        ) {
            return true;
        }

        const targetedPhrases = [
            this.runtime.character.name + " stop responding",
            this.runtime.character.name + " stop talking",
            this.runtime.character.name + " shut up",
            this.runtime.character.name + " stfu",
            "stop talking" + this.runtime.character.name,
            this.runtime.character.name + " stop talking",
            "shut up " + this.runtime.character.name,
            this.runtime.character.name + " shut up",
            "stfu " + this.runtime.character.name,
            this.runtime.character.name + " stfu",
            "chill" + this.runtime.character.name,
            this.runtime.character.name + " chill",
        ];

        // lose interest if pinged and told to stop responding
        if (targetedPhrases.some((phrase) => messageContent.includes(phrase))) {
            delete this.interestChannels[message.channelId];
            return true;
        }

        // if the message is short, ignore but maintain interest
        if (
            !this.interestChannels[message.channelId] &&
            messageContent.length < 2
        ) {
            return true;
        }

        const ignoreResponseWords = [
            "lol",
            "nm",
            "uh",
            "wtf",
            "stfu",
            "dumb",
            "jfc",
            "omg",
        ];
        if (
            message.content.length < 4 &&
            ignoreResponseWords.some((word) =>
                message.content.toLowerCase().includes(word)
            )
        ) {
            return true;
        }
        return false;
    }

    private async _shouldRespond(
        message: DiscordMessage,
        state: State
    ): Promise<boolean> {
        if (message.author.id === this.client.user?.id) return false;
        // if (message.author.bot) return false;
        if (message.mentions.has(this.client.user?.id as string)) return true;

        const guild = message.guild;
        const member = guild?.members.cache.get(this.client.user?.id as string);
        const nickname = member?.nickname;

        if (
            message.content
                .toLowerCase()
                .includes(this.client.user?.username.toLowerCase() as string) ||
            message.content
                .toLowerCase()
                .includes(this.client.user?.tag.toLowerCase() as string) ||
            (nickname &&
                message.content.toLowerCase().includes(nickname.toLowerCase()))
        ) {
            return true;
        }

        if (!message.guild) {
            return true;
        }

        // If none of the above conditions are met, use the generateText to decide
        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.discordShouldRespondTemplate ||
                this.runtime.character.templates?.shouldRespondTemplate ||
                discordShouldRespondTemplate,
        });

        const response = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.SMALL,
        });

        if (response === "RESPOND") {
            return true;
        } else if (response === "IGNORE") {
            return false;
        } else if (response === "STOP") {
            delete this.interestChannels[message.channelId];
            return false;
        } else {
            console.error(
                "Invalid response from response generateText:",
                response
            );
            return false;
        }
    }

    private async _generateResponse(
        message: Memory,
        state: State,
        context: string
    ): Promise<Content> {
        const { userId, roomId } = message;

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        if (!response) {
            console.error("No response from generateMessageResponse");
            return;
        }

        await this.runtime.databaseAdapter.log({
            body: { message, context, response },
            userId: userId,
            roomId,
            type: "response",
        });

        return response;
    }

    async fetchBotName(botToken: string) {
        const url = "https://discord.com/api/v10/users/@me";

        const response = await fetch(url, {
            method: "GET",
            headers: {
                Authorization: `Bot ${botToken}`,
            },
        });

        if (!response.ok) {
            throw new Error(
                `Error fetching bot details: ${response.statusText}`
            );
        }

        const data = await response.json();
        return data.username;
    }

    async handleSystemAction(targetChannelId: string, action: string) {
        try {
            // Find the first available text channel if target channel is not accessible
            let channel: TextChannel | null = null;
            try {
                channel = (await this.client.channels.fetch(
                    targetChannelId
                )) as TextChannel;
            } catch {
                // If target channel not found, find first available text channel
                for (const [, guild] of this.client.guilds.cache) {
                    const textChannel = guild.channels.cache.find(
                        (c) => c.isTextBased() && !c.isDMBased()
                    ) as TextChannel;
                    if (textChannel) {
                        channel = textChannel;
                        break;
                    }
                }
            }

            if (!channel) {
                throw new Error("No suitable text channel found");
            }

            const systemId = stringToUuid(`system-${this.runtime.agentId}`);
            const roomId = stringToUuid(
                `${channel.id}-${this.runtime.agentId}`
            );

            const memory: Memory = {
                id: stringToUuid(
                    `${action}-${Date.now()}-${this.runtime.agentId}`
                ),
                userId: systemId,
                agentId: this.runtime.agentId,
                roomId,
                content: {
                    text: action,
                    action,
                    source: "discord",
                },
                createdAt: Date.now(),
                embedding: getEmbeddingZeroVector(),
            };

            const callback: HandlerCallback = async (content: Content) => {
                try {
                    await sendMessageInChunks(channel!, content.text, "", []);
                    return [];
                } catch (error) {
                    elizaLogger.error("Error sending system message:", error);
                    return [];
                }
            };

            const state = await this.runtime.composeState(memory, {
                discordClient: this.client,
                discordMessage: memory,
                agentName:
                    this.runtime.character.name ||
                    this.client.user?.displayName,
            });

            await this.runtime.processActions(
                memory,
                [memory],
                state,
                callback
            );
        } catch (error) {
            elizaLogger.error("Error in handleSystemAction:", error);
        }
    }
}
