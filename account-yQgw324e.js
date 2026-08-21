import { n as __esmMin } from "./chunk-BRZcfu7K.js";
//#region ../../packages/agent-ui/src/utils/account.ts
var IOA_ENTERPRISE_IDS, isIOAUser, shouldUseRealAvatar;
var init_account = __esmMin((() => {
	IOA_ENTERPRISE_IDS = ["esoikz80kd8g", "etahzsqej0n4"];
	isIOAUser = (enterpriseId) => IOA_ENTERPRISE_IDS.includes(enterpriseId);
	shouldUseRealAvatar = (account) => account?.type === "personal" || isIOAUser(account?.enterpriseId ?? "");
}));
//#endregion
export { isIOAUser as n, shouldUseRealAvatar as r, init_account as t };
