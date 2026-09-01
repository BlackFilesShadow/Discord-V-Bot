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
import { handleMarketDirectBuyButton, handleMarketDirectBuyModal } from '../modules/economy/blackMarketInteractions';
import { handleMarketVendorCatalogPageButton } from '../modules/economy/blackMarketDiscord';
import {
  handleLegacyMarketOrderConfirmButton,
  handleLegacyMarketOrderSelect,
  handleMarketOrderAddButton,
  handleMarketOrderButton,
  handleMarketOrderCancelButton,
  handleMarketOrderItemSelect,
  handleMarketOrderManagerButton,
  handleMarketOrderManagerSelect,
  handleMarketOrderPageButton,
  handleMarketOrderPayButton,
  handleMarketOrderQuantitySelect,
} from '../modules/economy/blackMarketOrderInteractionsV2';
import { handleWhitelistApprovalButton } from '../modules/whitelist/whitelistApprovalButton';
import { handleFlagActivityButton } from '../modules/gameplayFeeds/flagActivity';
import { handleServerListCatalogButton, handleServerListCatalogSearch } from '../modules/nitrado/serverListCatalog';

function isCompositeOwnedComponent(i: Interaction): boolean {
  if (i.isButton()) {
    return i.customId.startsWith('vacct:')
      || i.customId.startsWith('vacct_mgr:')
      || i.customId.startsWith('vacct_mgr_move:')
      || i.customId.startsWith('vacct_mgr_order:')
      || i.customId.startsWith('marketbuy:')
      || i.customId.startsWith('marketcat:v1:')
      || i.customId.startsWith('marketorder:open:')
      || i.customId.startsWith('marketorder:page:')
      || i.customId.startsWith('marketorder:add:')
      || i.customId.startsWith('marketorder:pay:')
      || i.customId.startsWith('marketorder:confirm:')
      || i.customId.startsWith('marketorder:cancel:')
      || i.customId.startsWith('listcat:')
      || i.customId.startsWith('wlreq:u:')
      || i.customId.startsWith('flagshort:v1:');
  }
  if (i.isModalSubmit()) {
    return i.customId.startsWith('vacct:deposit_modal:')
      || i.customId.startsWith('vacct_mgr_modal:')
      || i.customId.startsWith('marketbuy_modal:')
      || i.customId.startsWith('listcat_search:');
  }
  if (i.isStringSelectMenu()) {
    return i.customId.startsWith('vacct_mgr_sel:')
      || i.customId.startsWith('vacct_mgr_order_sel:')
      || i.customId.startsWith('marketorder:item:')
      || i.customId.startsWith('marketorder:qty:')
      || i.customId.startsWith('marketorder:select:');
  }
  return false;
}

const interactionCreateComposite: BotEvent = {
  name: Events.InteractionCreate,
  execute: async (interaction: unknown) => {
    const i = interaction as Interaction;
    if (!isCompositeOwnedComponent(i)) {
      await legacyInteractionCreate.execute(interaction);
      return;
    }

    // Composite-eigene Komponenten bleiben unter demselben globalen Komponenten-
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
      if (i.customId.startsWith('flagshort:v1:')) return handleFlagActivityButton(i);
      if (i.customId.startsWith('wlreq:u:')) return handleWhitelistApprovalButton(i);
      if (i.customId.startsWith('marketcat:v1:')) return handleMarketVendorCatalogPageButton(i);
      if (i.customId.startsWith('marketbuy:')) return handleMarketDirectBuyButton(i);
      if (i.customId.startsWith('marketorder:open:')) return handleMarketOrderButton(i);
      if (i.customId.startsWith('marketorder:page:')) return handleMarketOrderPageButton(i);
      if (i.customId.startsWith('marketorder:add:')) return handleMarketOrderAddButton(i);
      if (i.customId.startsWith('marketorder:pay:')) return handleMarketOrderPayButton(i);
      if (i.customId.startsWith('marketorder:confirm:')) return handleLegacyMarketOrderConfirmButton(i);
      if (i.customId.startsWith('marketorder:cancel:')) return handleMarketOrderCancelButton(i);
      if (i.customId.startsWith('listcat:')) return handleServerListCatalogButton(i);
      if (i.customId.startsWith('vacct:deposit:')) return handleVirtualAccountDepositButton(i);
      if (i.customId.startsWith('vacct_mgr_move:')) return handleVirtualManagerMoveButton(i);
      if (i.customId.startsWith('vacct_mgr_order:')) return handleMarketOrderManagerButton(i);
      if (i.customId.startsWith('vacct_mgr:')) return handleVirtualManagerButton(i);
    }
    if (i.isStringSelectMenu()) {
      if (i.customId.startsWith('vacct_mgr_sel:')) return handleVirtualManagerSelect(i);
      if (i.customId.startsWith('vacct_mgr_order_sel:')) return handleMarketOrderManagerSelect(i);
      if (i.customId.startsWith('marketorder:item:')) return handleMarketOrderItemSelect(i);
      if (i.customId.startsWith('marketorder:qty:')) return handleMarketOrderQuantitySelect(i);
      if (i.customId.startsWith('marketorder:select:')) return handleLegacyMarketOrderSelect(i);
    }
    if (i.isModalSubmit()) {
      if (i.customId.startsWith('marketbuy_modal:')) return handleMarketDirectBuyModal(i);
      if (i.customId.startsWith('vacct:deposit_modal:')) return handleVirtualAccountDepositModal(i);
      if (i.customId.startsWith('vacct_mgr_modal:')) return handleVirtualManagerModal(i);
      if (i.customId.startsWith('listcat_search:')) return handleServerListCatalogSearch(i);
    }
  },
};

export default interactionCreateComposite;
