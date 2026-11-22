// src/pi-web-access/config.ts
import { join } from "node:path";
import { metisConfigPath } from "../../configuration/store.ts";
import { readWebAccessConfig, updateWebAccessConfig, webAccessAgentDir, WEB_CREDENTIALS_FILE } from "../../configuration/web-access.ts";
function webCredentialsPath() {
  return join(webAccessAgentDir(), WEB_CREDENTIALS_FILE);
}
function webPreferencesPath() {
  return metisConfigPath(webAccessAgentDir());
}
function loadWebAccessConfig() {
  return readWebAccessConfig(webAccessAgentDir());
}
function saveWebAccessConfig(patch) {
  updateWebAccessConfig(webAccessAgentDir(), patch);
}

export {
  webCredentialsPath,
  webPreferencesPath,
  loadWebAccessConfig,
  saveWebAccessConfig
};
