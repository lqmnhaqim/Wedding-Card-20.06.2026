import { z } from "zod";

export const rsvpSchema = z.object({
  fullName: z.string().min(2, "Full name is required (minimum 2 characters)."),
  attendance: z.enum(["attending", "not_attending"], {
    errorMap: () => ({ message: "Attendance must be 'attending' or 'not_attending'." }),
  }),
  pax: z.number().int().min(1).max(8).optional(),
  phoneNumber: z.string().optional(),
  message: z.string().optional(),
});

export function sanitizeApiError(error) {
  if (error instanceof z.ZodError) {
    const issues = error.issues || error.errors || [];
    return issues.map((e) => `${(e.path || []).join(".")}: ${e.message}`).join("; ");
  }
  if (error instanceof Error) {
    const msg = error.message;
    if (
      msg.includes("Please enter") ||
      msg.includes("must be") ||
      msg.includes("required") ||
      msg.includes("Unable to") ||
      msg.includes("Unable to")
    ) {
      return msg;
    }
  }
  return "An unexpected error occurred. Please try again later.";
}

export function formatRsvpTelegramMessage(saved, totalAttendancePax) {
  const attendance = saved.attendance || "not_attending";
  const isAttending = attendance === "attending";
  const status = isAttending ? "Will Attend" : "Cannot Attend";
  let msg = `\u2709 New RSVP\n\uD83D\uDC64 ${saved.full_name || "Guest"}\n\uD83D\uDCCD ${status}`;
  if (isAttending) {
    msg += `\n\uD83D\uDC65 Pax: ${saved.pax || 1}`;
    msg += `\n\uD83D\uDCCA Total Attending: ${totalAttendancePax}`;
  }
  if (saved.wish_message) {
    msg += `\n\uD83D\uDCAC Message: ${saved.wish_message}`;
  }
  return msg;
}
