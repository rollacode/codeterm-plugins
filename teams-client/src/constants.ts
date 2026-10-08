// exo-teams signs in as the first-party Teams desktop client (device code), so no tenant app consent is involved.
export const EXO_MODULE = "github.com/alxxpersonal/exo-teams";
export const EXO_COMMIT = "b9ebbf5583ee87c08a7fd2eacb1232b1633b4ad4";
export const EXO_VERSION = "v0.0.0-20260418032231-b9ebbf5583ee";
export const EXO_MODULE_SUM = "h1:HG7rlFtgLr0oauBj4gyqfBYzhU/2JPSlp1f0JRQS51A=";
export const EXO_PACKAGE = `${EXO_MODULE}/cmd/exo-teams`;
export const EXO_CLIENT_ID = "1fec8e78-bce4-4aaf-ab1b-5451cc387264";

export const GO_VERSION = "go1.26.8";
export const GO_DOWNLOAD_BASE = "https://go.dev/dl/";
export const GO_ARCHIVES: Record<string, { file: string; sha256: string }> = {
  "darwin/x64": { file: "go1.26.8.darwin-amd64.tar.gz", sha256: "186be014105aa6542b767d2c6ed5cca10a0214bdff809ef1724022a8c7894150" },
  "darwin/arm64": { file: "go1.26.8.darwin-arm64.tar.gz", sha256: "a012b25b571bd0138a03dcd25375ceba866fe5ca822f426d2c66a4de56fd3f4b" },
  "linux/x64": { file: "go1.26.8.linux-amd64.tar.gz", sha256: "d0f743b33e8d8945e6b1f432edd15785c70507121d6e2a723b21285eddf8b57b" },
  "linux/arm64": { file: "go1.26.8.linux-arm64.tar.gz", sha256: "211ffced9dcb9633a55eac6364816ec0ddd951389a740e88fa8b3337971bdda0" },
  "win32/x64": { file: "go1.26.8.windows-amd64.zip", sha256: "b92c3b2adae85a11ba71fe7216daf0d84e82af4c8ab6c5625807f28622043a59" },
  "win32/arm64": { file: "go1.26.8.windows-arm64.zip", sha256: "4bc560ed3ccb64eec0be6180b8c29185c07f5215276820adb4303d7bf3365435" },
};

export const ROOT = "~/.codeterm/teams-client";
export const EXO_HOME_DIR = "exo-home";
export const EXO_TOKEN_DIR = ".exo-teams";
export const EXO_TOKEN_FILES = ["token-skype.jwt", "token-chatsvcagg.jwt", "token-teams.jwt", "token-graph.jwt", "token-assignments.jwt", "refresh-token.jwt"];
export const EXO_REFRESH_TOKEN_FILE = "refresh-token.jwt";

export const DEVICE_LOGIN_URL = /https:\/\/(?:(?:aka\.ms|(?:www\.)?microsoft\.com)\/devicelogin|login\.microsoft(?:online)?\.com\/(?:device|common\/oauth2\/deviceauth))(?![\w.-])[^\s<>"']*/i;
export const SIGN_IN_TTL_MS = 15 * 60 * 1000;

export const TIMEOUTS = {
  probe: 15_000,
  whoami: 30_000,
  refresh: 60_000,
  chats: 120_000,
  send: 120_000,
  sendFile: 300_000,
  fileProbe: 120_000,
  history: 120_000,
  hash: 120_000,
  download: 600_000,
  extract: 600_000,
  goModule: 600_000,
  goBuild: 900_000,
};

export const CHAT_CACHE_TTL_MS = 10 * 60 * 1000;
export const MAX_COUNT = 50;
export const MAX_BYTES = 32 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_CHAT_MESSAGES = 200;
export const SEARCH_RECENT_MESSAGES = 50;
export const SEARCH_MAX_CHATS = 10;
// Each get-chat re-lists every chat and resolves member names, so a cross-chat scan stops at a time budget.
export const SEARCH_BUDGET_MS = 90_000;
