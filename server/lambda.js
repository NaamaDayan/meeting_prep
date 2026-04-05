import "./env.js";
import serverlessExpress from "@codegenie/serverless-express";
import { app } from "./server.js";

const serverlessExpressInstance = serverlessExpress({
  app,
  resolutionMode: "PROMISE",
});

export async function handler(event, context) {
  return serverlessExpressInstance(event, context);
}
