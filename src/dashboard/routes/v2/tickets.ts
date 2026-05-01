/**
 * Tickets-Templates: TODO Phase-1.5 — TicketTemplate-Model fehlt noch im Schema.
 * Bis dahin liefert dieser Router 501 fuer Mutations und einen leeren Stand fuer GET,
 * sodass das Dashboard ohne Crash mounten kann.
 */
import { Router } from 'express';
import { requireGuildPermission, requireGuildOwner } from '../../middleware/auth';

export const ticketsRouter = Router({ mergeParams: true });

ticketsRouter.get('/', requireGuildPermission('tickets.manage'), (_req, res) => {
  res.json({ templates: [], note: 'TicketTemplate-Model wird in einer Folge-Migration hinzugefuegt.' });
});

ticketsRouter.post('/', requireGuildOwner, (_req, res) => {
  res.status(501).json({ error: 'TicketTemplate-Model fehlt — Folge-Migration ausstehend.' });
});
ticketsRouter.put('/:id', requireGuildOwner, (_req, res) => {
  res.status(501).json({ error: 'TicketTemplate-Model fehlt — Folge-Migration ausstehend.' });
});
ticketsRouter.delete('/:id', requireGuildOwner, (_req, res) => {
  res.status(501).json({ error: 'TicketTemplate-Model fehlt — Folge-Migration ausstehend.' });
});
