import { commissionDirectTool, commissionTool } from "./commission.js";
import { ordersTool } from "./orders.js";
import { quoteTool } from "./quote.js";
import { refundTool } from "./refund.js";
import { reviewTool } from "./review.js";
import { statusTool } from "./status.js";
import { stylesTool } from "./styles.js";
import { verifyTool } from "./verify.js";

/** The frozen 9-tool surface (frozen-interfaces.md §8), in the order agents should discover them. */
export const TOOLS = [
  stylesTool,
  quoteTool,
  commissionTool,
  commissionDirectTool,
  statusTool,
  verifyTool,
  refundTool,
  reviewTool,
  ordersTool,
] as const;
