import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Economy-Lotterie — Gewinn-Lifecycle-Sicherheitsgate', () => {
  const lottery = read('src/modules/economy/lottery.ts');
  const route = read('src/dashboard/routes/v2/economyLottery.ts');
  const migration = read('prisma/migrations/20260828124500_economy_lottery_market_interest_completion/migration.sql');

  it('persistiert aktiven Freitext-Gewinn und unveraenderlichen Historien-Snapshot', () => {
    expect(migration).toContain('"activePrizeText" VARCHAR(256)');
    expect(migration).toContain('"prizeSnapshot" VARCHAR(256)');
    expect(lottery).toContain('UPDATE "LotteryRound" SET "activePrizeText"=$2, "prizeSnapshot"=$2 WHERE "id"=$1');
    expect(route).toContain('prizeText: round.activePrizeText ?? round.prizeSnapshot');
  });

  it('entfernt den aktiven Gewinn erst in erfolgreichen Terminalzustaenden', () => {
    const winner = lottery
      .slice(lottery.indexOf('async function completeWinnerPayout'), lottery.indexOf('async function processRefunds'))
      .replace(/\\'/g, "'");
    const refund = lottery
      .slice(lottery.indexOf('async function processRefunds'), lottery.indexOf('async function announceTerminalRound'))
      .replace(/\\'/g, "'");

    expect(winner).toContain('"status"=\'FINISHED\'::"LotteryRoundStatus"');
    expect(winner).toContain('"activePrizeText"=NULL');
    expect(winner).not.toContain('"prizeSnapshot"=NULL');

    expect(refund).toContain('"status"=\'REFUNDED\'::"LotteryRoundStatus"');
    expect(refund).toContain('"activePrizeText"=NULL');
    expect(refund).not.toContain('"prizeSnapshot"=NULL');
  });

  it('zeigt nach Abschluss weiterhin den Snapshot und nennt ihn in der Gewinner-Ankuendigung', () => {
    expect(lottery).toContain('const prizeText = round.activePrizeText ?? round.prizeSnapshot;');
    expect(lottery).toContain('round.prizeSnapshot ? ` Gewinn: **${round.prizeSnapshot}**.`');
  });

  it('laesst eine geloeschte Lotterie-Nachricht die Auswertung (Auszahlung, Pot-Archivierung, Gewinner-Ankuendigung) nicht dauerhaft blockieren', () => {
    // announceTerminalRound() hat bewusst KEIN eigenes try/catch um refreshLotteryMessage()
    // -- jeder ungefangene Fehler dort wuerde bei jedem Scheduler-Tick erneut geworfen,
    // solange announcedAt nicht gesetzt ist, und archiveTerminalPot() sowie die
    // Gewinner-Ankuendigung nie erreichen. Die Robustheit muss deshalb INNERHALB von
    // refreshLotteryMessage() liegen.
    const refresh = lottery.slice(
      lottery.indexOf('export async function refreshLotteryMessage'),
      lottery.indexOf('export async function createLotteryRound'),
    );
    expect(refresh).not.toContain('throw new Error(');
    expect(refresh).toContain(".messages.fetch(round.messageId).catch(() => null)");
    expect(refresh).toContain('await message.edit({ embeds: [await createLotteryEmbed(round)], components: createLotteryButtons(round) }).catch(error => {');

    const terminal = lottery.slice(
      lottery.indexOf('async function announceTerminalRound'),
      lottery.indexOf('async function archiveTerminalPot'),
    );
    expect(terminal).toContain('await refreshLotteryMessage(client, roundId);');
    expect(terminal).not.toContain('refreshLotteryMessage(client, roundId).catch(');
  });
});