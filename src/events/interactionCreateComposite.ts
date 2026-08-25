import { Events, Interaction, MessageFlags } from 'discord.js';
import type { BotEvent } from '../types';
import legacyInteractionCreate from './interactionCreate';
import { checkComponentRateLimit } from '../utils/rateLimit';
import { rateLimitedCounter } from '../utils/metrics';
import {
  handleVirtualAccountDepositButton,
  handleVirtualAccountDepositModal,
  handleVirtualManagerButton,
  handleVirtualManagerModal,
  handleVirtualManagerMoveButton,
  handleVirtualManagerSelect,
} from '../modules/economy/virtualAccountInteractions';

function isVirtualComponent(i: Interaction): boolean {
  if (i.isButton()) return i.customId.startsWith('vacct:') || i.customId.startsWith('vacct_mgr:') || i.customId.startsWith('vacct_mgr_move:');
  if (i.isModalSubmit()) return i.customId.startsWith('vacct:deposit_modal:') || i.customId.startsWith('vacct_mgr_modal:');
  if (i.isStringSelectMenu()) return i.customId.startsWith('vacct_mgr_sel:');
  return false;
}

const interactionCreateComposite: BotEvent = {
  name: Events.InteractionCreate,
  execute: async (interaction: unknown) => {
    const i = interaction as Interaction;
    if (!isVirtualComponent(i)) {
      await legacyInteractionCreate.execute(interaction);
      return;
    }

    // Die neuen Komponenten bleiben unter demselben globalen Komponenten-
    // Rate-Limit wie der Legacy-Dispatcher. Dadurch eroeffnet die vorgeschaltete
    // Route keinen zweiten, unlimitierten Interaktionspfad.
    if (!checkComponentRateLimit(i.user.id)) {
      rateLimitedCounter.inc({ kind: 'component' });
      if (i.isRepliable()) {
        await i.reply({ content: 'Zu viele Aktionen. Bitte einen Moment warten.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
      return;
    }

    if (i.isButton()) {
      if (i.customId.startsWith('vacct:deposit:')) return handleVirtualAccountDepositButton(i);
      if (i.customId.startsWith('vacct_mgr_move:')) return handleVirtualManagerMoveButton(i);
      if (i.customId.startsWith('vacct_mgr:')) return handleVirtualManagerButton(i);
    }
    if (i.isStringSelectMenu() && i.customId.startsWith('vacct_mgr_sel:')) {
      return handleVirtualManagerSelect(i);
    }
    if (i.isModalSubmit()) {
      if (i.customId.startsWith('vacct:deposit_modal:')) return handleVirtualAccountDepositModal(i);
      if (i.customId.startsWith('vacct_mgr_modal:')) return handleVirtualManagerModal(i);
    }
  },
};

export default interactionCreateComposite;
