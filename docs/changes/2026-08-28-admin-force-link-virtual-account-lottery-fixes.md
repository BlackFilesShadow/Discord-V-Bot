# Admin ForceLink, virtuelle Konten und Lotterie — Fixblock 2026-08-28

Dieser Branch behebt zusammenhaengende Produktionsfehler in Admin-Linking, virtuellen Konten und Lotterie.

- `/force-link` umgeht fuer Admins die normale ADM-/Session-Anwesenheits- und 5-Minuten-Regel. Ohne bekannte Session wird keine GUID erfunden; der exakte Spielername wird vorlaeufig gespeichert und spaeter bei einem eindeutigen Session-Treffer mit der echten GUID-HMAC reconciled.
- `/force-unlink` benoetigt keinen Session-Nachweis und entfernt auch einen noch nicht aufgeloesten Admin-Force-Link.
- Virtuelle Konten verwenden getrennte Discord-Kanaele fuer Live-Embed und Transaktions-Threads. Der Archiv-Thread wird nur im konfigurierten Archiv-Kanal erzeugt.
- Bestehende virtuelle Konten werden ueber den atomaren Konfigurationspfad aktualisiert.
- Unbenutzte CUSTOM/GENERAL-Konten koennen dauerhaft geloescht werden. Hard-Delete ist nur bei Wallet=0, Bank=0 und ohne Ledger-/Lotterie-/Markt-Historie erlaubt; Systemkonten und Serverbank bleiben geschuetzt.
- Die Lotterie hat eine sichere Default-Endzeit und sichtbare Formularvalidierung, damit der Start-Button nicht ohne Erklaerung deaktiviert bleibt.

Regressionen werden durch Command-, Security-, Runtime- und Playwright-Gates abgesichert. Merge erst nach gruenen CI-/Playwright-Gates.
