import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  PermissionFlagsBits
} from 'discord.js';
import { CONFIG } from '../config';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../database';
import fetch from 'node-fetch';

export const data = new SlashCommandBuilder()
  .setName('sendverificationembed')
  .setDescription('Send a verification embed')
  .addStringOption(option =>
    option.setName('title')
      .setDescription('The title of the verification embed')
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName('description')
      .setDescription('The description of the verification embed')
      .setRequired(true)
  )
  .addRoleOption(option =>
    option.setName('role')
      .setDescription('The role to give upon successful verification')
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName('webhookurl')
      .setDescription('Webhook URL to log verification events (optional)')
      .setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  const member = interaction.member;
  if (!member || !('roles' in member)) {
    await interaction.reply({ 
      content: 'Unable to verify your permissions.', 
      flags: 64
    });
    return;
  }

  const memberRoles = member.roles;
  const hasAdminRole: boolean = 'cache' in memberRoles ? memberRoles.cache.has(CONFIG.discord.adminRoleId) : false;
  if (!hasAdminRole) {
    await interaction.reply({ 
      content: 'You don\'t have permission to use this command', 
      flags: 64
    });
    return;
  }

  const title = interaction.options.getString('title', true);
  const description = interaction.options.getString('description', true);
  const role = interaction.options.getRole('role', true);
  const webhookUrl = interaction.options.getString('webhookurl');

  const botMember = interaction.guild?.members.cache.get(interaction.client.user.id);
  if (!botMember) {
    await interaction.reply({ 
      content: 'Unable to verify bot perms!', 
      flags: 64
    });
    return;
  }

  const botHighRole = botMember.roles.highest;
  if (role.position >= botHighRole.position) {
    await interaction.reply({ 
      content: `The role <@&${role.id}> is higher than or equal to my highest role <@&${botHighRole.id}>. Please move my role higher in the server settings or choose a lower role.`, 
      flags: 64
    });
    return;
  }

  const state = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  try {
    await prisma.verificationSession.create({
      data: {
        state,
        guildId: interaction.guildId!,
        channelId: interaction.channelId,
        roleId: role.id,
        webhookUrl: webhookUrl,
        expiresAt,
      },
    });

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor('#00b0f4')
      .setTimestamp()
      .setFooter({ text: 'Click verify!' });

    const verifyButton = new ButtonBuilder()
      .setCustomId(`verify_${state}`)
      .setLabel('Verify')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(verifyButton);

    if (interaction.channel && 'send' in interaction.channel) {
      await interaction.channel.send({
        embeds: [embed],
        components: [row],
      });
    }

    await interaction.reply({
      content: 'Panel created',
      flags: 64,
    });

    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            embeds: [{
              title: 'Verification Embed Created',
              description: `Created by ${interaction.user.tag}`,
              fields: [
                { name: 'Title', value: title, inline: true },
                { name: 'Role', value: role.name, inline: true },
                { name: 'Channel', value: `<#${interaction.channelId}>`, inline: true }
              ],
              color: 0x00ff00,
              timestamp: new Date().toISOString(),
            }],
          }),
        });
      } catch (e) {
        console.error('caught webhook logging error', e);
      }
    }

  } catch (e) {
    console.error('couldnt send/create verify panel:', e);
    if (interaction.replied) {
      await interaction.editReply({ 
        content: 'An error occured!'
      });
    } else {
      await interaction.reply({ 
        content: 'An error occurred!', 
        flags: 64
      });
    }
  }
}