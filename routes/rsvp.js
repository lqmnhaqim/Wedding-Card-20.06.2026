import { z } from "zod";
import { rsvpSchema, sanitizeApiError, formatRsvpTelegramMessage } from "../lib/helpers.js";

async function sendTelegramNotification(botToken, chatId, message) {
  if (!botToken || !chatId) return { ok: false, skipped: true };
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
  });
  if (!res.ok) throw new Error("Telegram send failed");
  return res.json();
}

export default function registerRsvpRoutes(app) {
  app.post("/api/rsvp/:projectKey", async (req, res) => {
    try {
      const supabase = req.app.get("supabase");
      if (!supabase) return res.status(500).json({ error: "Database not available." });

      const parsed = rsvpSchema.parse(req.body || {});
      const isAttending = parsed.attendance === "attending";
      const { data: project } = await supabase.from("wc_projects").select("id").eq("project_key", req.params.projectKey).single();
      if (!project) return res.status(404).json({ error: "Project not found." });

      const payload = {
        project_id: project.id,
        full_name: parsed.fullName.trim(),
        attendance: parsed.attendance,
        pax: isAttending ? Math.min(Math.max(Number(parsed.pax || 1), 1), 8) : null,
        wish_message: (parsed.message || "").trim(),
      };

      const { data: inserted, error: insertErr } = await supabase.from("wc_rsvps").insert(payload).select();
      if (insertErr) throw insertErr;

      const saved = inserted?.[0] || payload;
      let totalAttendancePax = 0;
      try {
        const { data: attendingRows } = await supabase
          .from("wc_rsvps")
          .select("pax")
          .eq("project_id", project.id)
          .eq("attendance", "attending");
        if (Array.isArray(attendingRows)) {
          totalAttendancePax = attendingRows.reduce((sum, row) => sum + Number(row?.pax || 0), 0);
        }
      } catch (_) {
        /* best effort */
      }

      const telegramEnabled = process.env.TELEGRAM_ENABLED !== "false";
      if (telegramEnabled) {
        const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
        const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
        await sendTelegramNotification(botToken, chatId, formatRsvpTelegramMessage(saved, totalAttendancePax)).catch(
          () => null,
        );
      }

      res.json({ ok: true, data: inserted });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      res.status(status).json({ error: sanitizeApiError(error) });
    }
  });

  app.get("/api/rsvp-wishes/:projectKey", async (req, res) => {
    try {
      const supabase = req.app.get("supabase");
      if (!supabase) return res.status(500).json({ error: "Database not available." });

      const { data: project } = await supabase.from("wc_projects").select("id").eq("project_key", req.params.projectKey).single();
      if (!project) return res.status(404).json({ error: "Project not found." });

      const { data, error } = await supabase
        .from("wc_rsvps")
        .select("full_name,wish_message,created_at")
        .eq("project_id", project.id)
        .not("wish_message", "is", null)
        .order("created_at", { ascending: false })
        .limit(30);

      if (error) throw error;

      const wishes = (data || [])
        .map((row) => ({
          name: String(row.full_name || "").trim(),
          message: String(row.wish_message || "").trim(),
          created_at: row.created_at || null,
        }))
        .filter((row) => row.name && row.message);

      res.json({ wishes });
    } catch (error) {
      res.status(500).json({ error: sanitizeApiError(error) });
    }
  });
}
