/**
 * AWS Lambda entry (API Gateway HTTP API or REST API proxy integration).
 * Do not import loadEnv.js — use Lambda environment variables for secrets.
 */
import serverless from "serverless-http";
import { createApp } from "./app.js";

const app = createApp();

export const handler = serverless(app);
