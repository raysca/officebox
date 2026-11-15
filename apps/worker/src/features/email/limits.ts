import { defineLimit } from "../../core/rate-limit";

/**
 * Send test email: 5 per hour per actor **(default)**, so it can't be used to flood the actor's inbox or
 * the provider's quota. Counted only for test emails actually queued (refused or unqueued ones are
 * refunded or never counted).
 */
export const TEST_EMAIL_LIMIT = defineLimit({
  mechanism: "d1",
  name: "email_test",
  limit: 5,
  window: { kind: "fixed", seconds: 3600 },
});
