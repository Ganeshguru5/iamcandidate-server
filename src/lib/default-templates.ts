import type { EmailTemplate } from "../models"

/**
 * Starter templates every account gets: emails (sent from knot) and LinkedIn
 * messages (copied into LinkedIn). Variables in {{ }} are filled in by the
 * frontend: name, company, role, jobUrl, jobId and senderName. Anything not
 * filled stays visible so it's easy to spot.
 *
 * Ids are stable (`tpl_default_<key>`), so seeding twice never duplicates a
 * template. To add templates, append them with `since` set to a new
 * DEFAULT_TEMPLATES_VERSION: existing accounts then get only those, once,
 * and never get back the ones they deleted.
 */
export const DEFAULT_TEMPLATES_VERSION = 2

/** LinkedIn's limit for the note on a connection request. */
export const LINKEDIN_CONNECTION_NOTE_LIMIT = 300

export type DefaultTemplate = Pick<
  EmailTemplate,
  "id" | "name" | "category" | "subject" | "body"
> & {
  channel: NonNullable<EmailTemplate["channel"]>
  /** DEFAULT_TEMPLATES_VERSION that introduced this template. */
  since: number
}

type Draft = Omit<DefaultTemplate, "channel" | "since">

const EMAIL_TEMPLATES: Draft[] = [
  {
    id: "tpl_default_referral_request",
    name: "Referral request",
    category: "referral",
    subject: "Referral request: {{role}} at {{company}}",
    body: `Hi {{name}},

I hope you're doing well. I came across the {{role}} opening at {{company}} and I'm very interested in it. My experience lines up closely with what the team is looking for.

Job ID: {{jobId}}
Link: {{jobUrl}}

Would you be comfortable referring me? I've attached my resume, and I'm happy to send a short summary you can pass along if that makes it easier.

Thank you for considering it.

Best,
{{senderName}}`,
  },
  {
    id: "tpl_default_referral_nudge",
    name: "Referral follow-up",
    category: "referral",
    subject: "Re: Referral request: {{role}} at {{company}}",
    body: `Hi {{name}},

Just following up on my note about the {{role}} role at {{company}} ({{jobUrl}}). I know you're busy, so no worries if now isn't a good time.

If it helps, I can send a two-line summary of my background or anything else you need for the referral form.

Thanks again,
{{senderName}}`,
  },
  {
    id: "tpl_default_referral_thanks",
    name: "Thanks for the referral",
    category: "referral",
    subject: "Thank you for the referral",
    body: `Hi {{name}},

Thank you so much for referring me for the {{role}} role at {{company}}. I really appreciate you taking the time to do it.

I'll keep you posted on how it goes.

Best,
{{senderName}}`,
  },
  {
    id: "tpl_default_recruiter_outreach",
    name: "Recruiter outreach",
    category: "outreach",
    subject: "{{role}} at {{company}}",
    body: `Hi {{name}},

I noticed {{company}} is hiring for a {{role}}, and I'd love to be considered. My background is a strong match for the role, and I've attached my resume for a quick look.

Would you be open to a short call this week to see if there's a fit?

Thanks,
{{senderName}}`,
  },
  {
    id: "tpl_default_hiring_manager",
    name: "Hiring manager introduction",
    category: "outreach",
    subject: "Interested in the {{role}} role on your team",
    body: `Hi {{name}},

I saw that your team at {{company}} is hiring a {{role}}. I've applied through the careers page and wanted to introduce myself directly.

I'd welcome the chance to learn more about what the team is working on and share how I could contribute. My resume is attached.

Best regards,
{{senderName}}`,
  },
  {
    id: "tpl_default_application_follow_up",
    name: "Application follow-up",
    category: "follow_up",
    subject: "Following up on my application: {{role}}",
    body: `Hi {{name}},

I applied for the {{role}} position at {{company}} recently and wanted to follow up. I'm still very interested in the role and would be glad to share anything else that helps your review.

Thank you for your time,
{{senderName}}`,
  },
  {
    id: "tpl_default_interview_availability",
    name: "Interview availability",
    category: "interview",
    subject: "Re: Interview for {{role}}",
    body: `Hi {{name}},

Thank you for the invitation to interview for the {{role}} role at {{company}}. I'm available at the following times:

-
-
-

If none of these work, I'm happy to adjust. Looking forward to speaking with you.

Best,
{{senderName}}`,
  },
  {
    id: "tpl_default_interview_thanks",
    name: "Interview thank you",
    category: "interview",
    subject: "Thank you: {{role}} interview",
    body: `Hi {{name}},

Thank you for taking the time to speak with me about the {{role}} role at {{company}}. I enjoyed our conversation and came away even more excited about the team and the work.

Please let me know if there's anything else I can provide.

Best regards,
{{senderName}}`,
  },
  {
    id: "tpl_default_feedback_request",
    name: "Feedback after rejection",
    category: "follow_up",
    subject: "Re: {{role}} at {{company}}",
    body: `Hi {{name}},

Thank you for letting me know, and for the time you and the team spent with me during the process.

If you're able to share any feedback on where I could improve, I'd really appreciate it. I'd also love to be considered for future roles at {{company}}.

All the best,
{{senderName}}`,
  },
  {
    id: "tpl_default_withdraw",
    name: "Withdraw application",
    category: "other",
    subject: "Withdrawing my application: {{role}}",
    body: `Hi {{name}},

Thank you for considering me for the {{role}} role at {{company}}. After some thought, I've decided to withdraw my application at this time.

I appreciate your time and hope our paths cross again.

Best regards,
{{senderName}}`,
  },
]

/**
 * LinkedIn messages. No subject. "Connection request" templates must stay
 * under LinkedIn's 300-character note limit once the variables are filled.
 */
const LINKEDIN_TEMPLATES: Draft[] = [
  {
    id: "tpl_default_li_connect_referral",
    name: "Connection request: referral",
    category: "referral",
    subject: "",
    body: `Hi {{name}}, I'm applying for the {{role}} role at {{company}} and would love to connect. I'd really appreciate a quick chat about the team, or a referral if you think I'd be a good fit. Thank you!`,
  },
  {
    id: "tpl_default_li_referral_request",
    name: "Referral request",
    category: "referral",
    subject: "",
    body: `Hi {{name}}, thanks for connecting!

I'm applying for the {{role}} role at {{company}} (Job ID: {{jobId}}) and it lines up closely with my experience.

{{jobUrl}}

Would you be open to referring me? I can send my resume and a short summary for the referral form, whatever makes it easiest for you.

Thanks so much,
{{senderName}}`,
  },
  {
    id: "tpl_default_li_referral_warm",
    name: "Referral request: someone you know",
    category: "referral",
    subject: "",
    body: `Hey {{name}}, hope you're doing well!

I saw {{company}} is hiring a {{role}} and I'm planning to apply. Since you know my work, would you be comfortable putting in a referral for me?

Job ID: {{jobId}}
{{jobUrl}}

Happy to send my latest resume. Thanks a lot!
{{senderName}}`,
  },
  {
    id: "tpl_default_li_referral_follow_up",
    name: "Referral follow-up",
    category: "referral",
    subject: "",
    body: `Hi {{name}}, just following up on my message about the {{role}} role at {{company}}. No pressure at all if you're busy. If it helps, I can send a two-line summary for the referral form. Thanks again!`,
  },
  {
    id: "tpl_default_li_referral_thanks",
    name: "Thanks for the referral",
    category: "referral",
    subject: "",
    body: `Hi {{name}}, thank you so much for referring me for the {{role}} role at {{company}}! I really appreciate it, and I'll keep you posted on how it goes.`,
  },
  {
    id: "tpl_default_li_connect_recruiter",
    name: "Connection request: recruiter",
    category: "outreach",
    subject: "",
    body: `Hi {{name}}, I noticed {{company}} is hiring for a {{role}}. My background is a strong match and I'd love to connect and learn more about the role. Thanks!`,
  },
  {
    id: "tpl_default_li_recruiter_message",
    name: "Recruiter message",
    category: "outreach",
    subject: "",
    body: `Hi {{name}},

I came across the {{role}} opening at {{company}} and I'm very interested. My experience is a close fit for what the team is looking for.

{{jobUrl}}

Would you be open to a quick call, or could you point me to the right person on the team?

Thanks,
{{senderName}}`,
  },
]

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  ...EMAIL_TEMPLATES.map((t) => ({ ...t, channel: "email" as const, since: 1 })),
  ...LINKEDIN_TEMPLATES.map((t) => ({ ...t, channel: "linkedin" as const, since: 2 })),
]
