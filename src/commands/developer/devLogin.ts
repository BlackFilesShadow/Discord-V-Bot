import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';

/**
 * /dev-login – Öffnet das Developer-Passwort-Modal.
 * Nach erfolgreicher Eingabe ist die DEV-Session 2 Stunden aktiv.
 * Der eigentliche Modal-Flow wird in interactionCreate.ts gehandhabt,
 * da dieser Command als devOnly markiert ist.
 */
const devLoginCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('dev-login')
    .setDescription('🔐 Developer-Bereich freischalten (Passwort-Eingabe)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  devOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    // Wenn wir hier ankommen, ist der User bereits authentifiziert
    // (interactionCreate.ts hat das Modal bereits verarbeitet)
    await interaction.reply({
      content: '✅ Du bist bereits als Developer authentifiziert. Deine Session ist aktiv.',
      ephemeral: true,
    });
  },
};

export default devLoginCommand;
