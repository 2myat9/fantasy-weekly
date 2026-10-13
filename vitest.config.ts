import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Stand-ins for the secrets, so tests never depend on .dev.vars.
      miniflare: {
        bindings: {
          ANTHROPIC_API_KEY: "test-anthropic-key",
          SLEEPER_USERNAME: "test-manager",
          TELEGRAM_BOT_TOKEN: "1234:test-bot-token",
          TELEGRAM_CHAT_ID: "5550001",
          TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret"
        }
      }
    })
  ]
});
