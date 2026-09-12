import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

describe('Feedback management global developer gate', () => {
  const v2 = read('src/dashboard/routes/v2.ts');

  it('gates every active feedback management surface with the canonical global developer identity', () => {
    expect(v2).toContain("v2Router.use('/bot-admin/command-center/feedback-channel', requireGlobalDeveloperIdentity);");
    expect(v2).toContain("v2Router.use('/bot-admin/command-center/feedback', requireGlobalDeveloperIdentity);");
    expect(v2).toContain("v2Router.use('/bot-admin/feedback', requireGlobalDeveloperIdentity);");
  });

  it('runs the feedback gates before the generic Bot-Admin routers can handle the requests', () => {
    const commandFeedbackChannel = v2.indexOf("v2Router.use('/bot-admin/command-center/feedback-channel', requireGlobalDeveloperIdentity);");
    const commandFeedback = v2.indexOf("v2Router.use('/bot-admin/command-center/feedback', requireGlobalDeveloperIdentity);");
    const genericCommandCenter = v2.indexOf("v2Router.use('/bot-admin/command-center', requireGlobalBotAdminIdentity");
    const legacyFeedback = v2.indexOf("v2Router.use('/bot-admin/feedback', requireGlobalDeveloperIdentity);");
    const genericBotAdmin = v2.indexOf("v2Router.use('/bot-admin', requireGlobalBotAdminIdentity");

    expect(commandFeedbackChannel).toBeGreaterThan(-1);
    expect(commandFeedback).toBeGreaterThan(-1);
    expect(genericCommandCenter).toBeGreaterThan(commandFeedbackChannel);
    expect(genericCommandCenter).toBeGreaterThan(commandFeedback);
    expect(legacyFeedback).toBeGreaterThan(-1);
    expect(genericBotAdmin).toBeGreaterThan(legacyFeedback);
  });

  it('does not change or retire the public user feedback command', () => {
    const publicFeedback = read('src/commands/user/feedback.ts');
    expect(publicFeedback).toContain(".setName('feedback')");
    expect(publicFeedback).toContain('export async function handleFeedbackModal');
  });
});
