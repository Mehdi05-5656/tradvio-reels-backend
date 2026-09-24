import type { Request } from "express";
import { isOperator } from "./auth.js";
import { managedEnabled } from "./managed-provisioning.js";

/** Presentation hint only. Every mutation independently authorizes the request. */
export function accountCapabilities(req: Request) {
  return {
    operate_accounts: isOperator(req),
    managed_setup_enabled: managedEnabled(),
  };
}
