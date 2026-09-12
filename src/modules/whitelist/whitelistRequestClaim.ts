export interface WhitelistRequestClaimScope {
  guildId: string;
  nitradoConnId: string;
}

export interface WhitelistRequestClaimInput {
  scope: WhitelistRequestClaimScope;
  gameId: string;
  channelId: string;
  requesterDiscordId: string;
  maxActivePerUser: number;
}

export type WhitelistRequestClaimResult =
  | { kind: 'CREATED'; request: { id: string } }
  | { kind: 'ALREADY_PENDING'; createdAt: Date }
  | { kind: 'LIMIT_REACHED'; activeCount: number };

interface ClaimTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  whitelistRequest: {
    findFirst(args: unknown): Promise<{ createdAt: Date } | null>;
    count(args: unknown): Promise<number>;
    create(args: unknown): Promise<{ id: string }>;
  };
}

export interface WhitelistRequestClaimClient {
  $transaction<T>(work: (tx: ClaimTx) => Promise<T>): Promise<T>;
}

function normalizedGameId(value: string): string {
  return value.trim().toLocaleLowerCase('de-DE');
}

/**
 * Finale, cross-process Race-Grenze fuer Whitelist-Antraege.
 *
 * Der normale Command darf vorher schnelle UX-/Remote-Preflights ausfuehren;
 * unmittelbar vor der Mutation werden unter einem transaction-scoped Advisory-
 * Lock Pending-Duplikat und User-Limit erneut geprueft. Damit koennen zwei
 * parallele Interactions fuer denselben Guild+Gameserver+Spielernamen niemals
 * zwei PENDING-Requests erzeugen.
 */
export async function claimWhitelistRequest(
  client: WhitelistRequestClaimClient,
  input: WhitelistRequestClaimInput,
): Promise<WhitelistRequestClaimResult> {
  const gameId = input.gameId.trim();
  const subject = `whitelist-request:${input.scope.guildId}:${input.scope.nitradoConnId}:${normalizedGameId(gameId)}`;

  return client.$transaction(async tx => {
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      subject,
    );

    const pending = await tx.whitelistRequest.findFirst({
      where: {
        guildId: input.scope.guildId,
        nitradoConnId: input.scope.nitradoConnId,
        gameId: { equals: gameId, mode: 'insensitive' },
        status: 'PENDING',
      },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (pending) return { kind: 'ALREADY_PENDING', createdAt: pending.createdAt } as const;

    const activeCount = await tx.whitelistRequest.count({
      where: {
        guildId: input.scope.guildId,
        nitradoConnId: input.scope.nitradoConnId,
        requesterDiscordId: input.requesterDiscordId,
        status: { in: ['PENDING', 'APPROVED'] },
      },
    });
    if (activeCount >= input.maxActivePerUser) {
      return { kind: 'LIMIT_REACHED', activeCount } as const;
    }

    const request = await tx.whitelistRequest.create({
      data: {
        guildId: input.scope.guildId,
        nitradoConnId: input.scope.nitradoConnId,
        channelId: input.channelId,
        requesterDiscordId: input.requesterDiscordId,
        gameId,
      },
      select: { id: true },
    });
    return { kind: 'CREATED', request } as const;
  });
}
