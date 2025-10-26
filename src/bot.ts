import { Client, GatewayIntentBits, Events, Collection, ButtonInteraction, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { CONFIG } from './config';
import { connectDatabase, prisma } from './database';
import * as sendVerificationEmbedCommand from './commands/sendverificationembed';

export class VerificationBot {
  public client: Client;
  public commands: Collection<string, any>;
  public pendingMessageUpdates: Map<string, any> = new Map();
  public userInteractions: Map<string, ButtonInteraction> = new Map();

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
      ],
    });

    this.commands = new Collection();
    this.commands.set(sendVerificationEmbedCommand.data.name, sendVerificationEmbedCommand);
  }

  async start() {
    try {
      await connectDatabase();
      await this.registerEvents();
      await this.client.login(CONFIG.discord.token);
      console.log('Discord bot started successfully');
    } catch (error) {
      console.error('Failed to start', error);
      process.exit(1);
    }
  }

  private async registerEvents() {
    this.client.once(Events.ClientReady, async (readyClient) => {
      console.log(`Logged in as ${readyClient.user.tag}`);
      await this.registerSlashCommands();
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (interaction.isChatInputCommand()) {
        const command = this.commands.get(interaction.commandName);
        if (!command) return;

        try {
          await command.execute(interaction);
        } catch (error) {
          console.error('err executing command:', error);
          const reply = { 
            content: 'There was a error running this command!', 
            flags: 64
          };
          
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp(reply);
          } else {
            await interaction.reply(reply);
          }
        }
      } else if (interaction.isButton()) {
        await this.handleButtonInteraction(interaction);
      }
    });
  }

  private async handleButtonInteraction(interaction: ButtonInteraction) {
    if (!interaction.customId.startsWith('verify_')) return;

      const originalState = interaction.customId.replace('verify_', '');
    
    try {
      const { v4: uuidv4 } = await import('uuid');
      const newState = uuidv4();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);      const originalSession = await prisma.verificationSession.findUnique({
        where: { state: originalState },
      });

      if (!originalSession) {
        await interaction.reply({
          content: 'This verification panel is no longer valid. Please ask an admin to create a new one.',
          flags: 64,
        });
        return;
      }

      await prisma.verificationSession.create({
        data: {
          state: newState,
          guildId: originalSession.guildId,
          channelId: originalSession.channelId,
          roleId: originalSession.roleId,
          expiresAt,
        },
      });

      await this.cleanupExpiredSessions();

      const oauthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CONFIG.discord.clientId}&redirect_uri=${encodeURIComponent(CONFIG.server.baseUrl + '/verify')}&response_type=code&scope=identify&state=${newState}`;

      const oauthButton = new ButtonBuilder()
        .setLabel('Verify yourself!')
        .setStyle(ButtonStyle.Link)
        .setURL(oauthUrl);

      const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(oauthButton);

      await interaction.reply({
        content: '**Click the button below to complete verification:**\n\n*This will open Discord authorization in a new tab.*',
        components: [row],
        flags: 64,
      });

      this.userInteractions.set(interaction.user.id, interaction);
      
      this.startVerificationCheck(interaction.user.id);

    } catch (error) {
      console.error('error handling interaction for btn:', error);
      await interaction.reply({
        content: 'An error occurred during verification. Please try again.',
        flags: 64,
      });
    }
  }

  private async registerSlashCommands() {
    try {
      const commands = this.commands.map(cmd => cmd.data.toJSON());
      
      if (CONFIG.discord.guildId) {
        const guild = this.client.guilds.cache.get(CONFIG.discord.guildId);
        if (guild) {
          await guild.commands.set(commands);
          // there's only 1 command - but if YOU want to add more you should specify command.length
          console.log(`Registered all / commands for server ${guild.name}`);
        }
      } else {
        await this.client.application?.commands.set(commands);
        console.log(`Registered all server / commands`);
      }
    } catch (error) {
      console.error('err registering / cmds:', error);
    }
  }

  private startVerificationCheck(userId: string) {
    const checkInterval = setInterval(async () => {
      try {
        const updateInfo = this.pendingMessageUpdates.get(userId);
        const interaction = this.userInteractions.get(userId);

        if (updateInfo && interaction) {
          await interaction.editReply({
            content: updateInfo.content,
            components: [],
          });

          this.pendingMessageUpdates.delete(userId);
          this.userInteractions.delete(userId);
          clearInterval(checkInterval);
        } else if (Date.now() - (updateInfo?.timestamp || Date.now()) > 300000) {
          this.userInteractions.delete(userId);
          clearInterval(checkInterval);
        }
      } catch (error) {
        console.error('checking verify status failed', error);
        clearInterval(checkInterval);
      }
    }, 2000);
  }

  private async cleanupExpiredSessions() {
    try {
      const deleted = await prisma.verificationSession.deleteMany({
        where: {
          expiresAt: {
            lt: new Date()
          }
        }
      });
    } catch (e) {
      console.error(e);
    }
  }
}