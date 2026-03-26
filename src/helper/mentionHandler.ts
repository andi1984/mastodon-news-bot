import { answerQuestion, QASettings } from "./questionAnswerer.js";

export async function isNewsTootThread(
  mastoClient: any,
  inReplyToId: string,
  botUsername: string,
): Promise<boolean> {
  try {
    const context = await mastoClient.v1.statuses
      .$select(inReplyToId)
      .context.fetch();
    const ancestors = context.ancestors ?? [];

    if (ancestors.length === 0) {
      const parent = await mastoClient.v1.statuses.$select(inReplyToId).fetch();
      return parent.account.acct === botUsername;
    }

    const root = ancestors[0];
    return root.account.acct === botUsername;
  } catch (err) {
    console.error(`mention-replier: thread detection failed: ${err}`);
    return true;
  }
}

export async function handleMentions(
  mastoClient: any,
  config: { username: string; qa_enabled?: boolean } & QASettings,
): Promise<void> {
  const notifications = await mastoClient.v1.notifications.list({
    types: ["mention"],
  });

  for (const notification of notifications) {
    const status = notification.status;

    if (!status) {
      await mastoClient.v1.notifications.$select(notification.id).dismiss();
      continue;
    }

    if (status.account.acct === config.username) {
      await mastoClient.v1.notifications.$select(notification.id).dismiss();
      continue;
    }

    if (config.qa_enabled === false) {
      await mastoClient.v1.notifications.$select(notification.id).dismiss();
      continue;
    }

    if (status.inReplyToId) {
      const isNews = await isNewsTootThread(
        mastoClient,
        status.inReplyToId,
        config.username,
      );
      if (isNews) {
        await mastoClient.v1.notifications.$select(notification.id).dismiss();
        continue;
      }
    }

    const replyText = await answerQuestion(
      status.account.acct,
      status.content,
      config,
    );

    await mastoClient.v1.statuses.create({
      status: replyText,
      inReplyToId: status.id,
      visibility: "unlisted",
      language: "de",
    });

    await mastoClient.v1.notifications.$select(notification.id).dismiss();
  }
}
