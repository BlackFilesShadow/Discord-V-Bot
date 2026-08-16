from pathlib import Path

add_path = Path('src/events/messageReactionAdd.ts')
s = add_path.read_text(encoding='utf-8')
old = '''          if (existingVotes.length > 0) {
            // Bestehende Stimme(n) aus DB löschen
            await prisma.pollVote.deleteMany({
              where: { pollId: poll.id, userId: dbUser.id },
            });
            await prisma.poll.update({
              where: { id: poll.id },
              data: { totalVotes: { decrement: existingVotes.length } },
            });

            // Vorherige Emoji-Reaktionen des Users entfernen
'''
new = '''          if (existingVotes.length > 0) {
            // Vote-Loeschung + Counter-Korrektur sind eine atomare, Guild-gescoppte Einheit.
            // Wir dekrementieren ausschliesslich die tatsaechlich geloeschten DB-Zeilen,
            // damit parallele Reaction-Events den Counter nicht unterlaufen lassen.
            await prisma.$transaction(async tx => {
              const deleted = await tx.pollVote.deleteMany({
                where: { pollId: poll.id, userId: dbUser.id },
              });
              if (deleted.count === 0) return;
              const updated = await tx.poll.updateMany({
                where: { id: poll.id, guildId },
                data: { totalVotes: { decrement: deleted.count } },
              });
              if (updated.count !== 1) {
                throw new Error(`Scoped Poll-Counter-Update fehlgeschlagen: ${poll.id}/${guildId}`);
              }
            });

            // Vorherige Emoji-Reaktionen des Users entfernen
'''
if old not in s:
    raise SystemExit('messageReactionAdd poll block not found')
add_path.write_text(s.replace(old, new, 1), encoding='utf-8')

remove_path = Path('src/events/messageReactionRemove.ts')
s = remove_path.read_text(encoding='utf-8')
old = '''        const deleted = await prisma.pollVote.deleteMany({
          where: { pollId: poll.id, userId: dbUser.id, optionId: matchedOption.id },
        });

        if (deleted.count > 0) {
          await prisma.poll.update({
            where: { id: poll.id },
            data: { totalVotes: { decrement: deleted.count } },
          });

          logAudit('POLL_VOTE_REMOVED', 'POLL', {
'''
new = '''        const deletedCount = await prisma.$transaction(async tx => {
          const deleted = await tx.pollVote.deleteMany({
            where: { pollId: poll.id, userId: dbUser.id, optionId: matchedOption.id },
          });
          if (deleted.count === 0) return 0;
          const updated = await tx.poll.updateMany({
            where: { id: poll.id, guildId },
            data: { totalVotes: { decrement: deleted.count } },
          });
          if (updated.count !== 1) {
            throw new Error(`Scoped Poll-Counter-Update fehlgeschlagen: ${poll.id}/${guildId}`);
          }
          return deleted.count;
        });

        if (deletedCount > 0) {
          logAudit('POLL_VOTE_REMOVED', 'POLL', {
'''
if old not in s:
    raise SystemExit('messageReactionRemove poll block not found')
remove_path.write_text(s.replace(old, new, 1), encoding='utf-8')
print('poll transaction/scope hardening applied')
