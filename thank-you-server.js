import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const billplzApp = express.Router();

billplzApp.get("/", (_req, res) => res.sendFile(path.join(__dirname, "thank-you.html")));

billplzApp.post("/api/contributions/webhook", express.text({ type: "*/*" }), async (req, res) => {
  req.rawBody = req.body || "";
  const { contributionWebhook } = await import("./contribution-api.js");
  return contributionWebhook(req, res);
});

export default billplzApp;
