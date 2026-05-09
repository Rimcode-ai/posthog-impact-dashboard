import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: process.env.DASHBOARD_URL || "http://localhost:8765/",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: process.env.DASHBOARD_URL ? undefined : {
    command: "python3 -m http.server 8765 --directory docs",
    url: "http://localhost:8765/",
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
