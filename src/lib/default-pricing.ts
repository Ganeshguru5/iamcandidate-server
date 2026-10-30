import type { PricingConfig } from "../models"

/** What the pricing page shows until an admin saves their own plans. */
export const DEFAULT_PRICING: PricingConfig = {
  currency: "INR",
  note: "Prices include GST. Cancel any time; your data stays exportable on every plan.",
  plans: [
    {
      id: "plan_free",
      name: "Free",
      tagline: "Everything you need to run one job search.",
      monthlyPrice: 0,
      yearlyPrice: 0,
      features: [
        "Up to 25 active applications",
        "Contacts, referrals and interviews",
        "Browser extension",
        "Email and LinkedIn templates",
        "1 GB document storage",
      ],
      ctaLabel: "Start free",
      ctaHref: "/login",
      highlighted: false,
      visible: true,
    },
    {
      id: "plan_pro",
      name: "Pro",
      tagline: "For an active search with lots of moving parts.",
      monthlyPrice: 299,
      yearlyPrice: 249,
      features: [
        "Unlimited applications",
        "Google Drive and Calendar sync",
        "GitHub and LinkedIn import",
        "LaTeX resume builder",
        "Send email from your own mailbox",
        "10 GB document storage",
      ],
      ctaLabel: "Get Pro",
      ctaHref: "/login",
      highlighted: true,
      visible: true,
    },
    {
      id: "plan_coach",
      name: "Coach",
      tagline: "For career coaches and placement teams.",
      monthlyPrice: 999,
      yearlyPrice: 849,
      features: [
        "Everything in Pro",
        "Up to 10 member workspaces",
        "Admin user management",
        "S3 backups to your own bucket",
        "Priority support",
      ],
      ctaLabel: "Contact us",
      ctaHref: "mailto:hello@example.com?subject=iamcandidate%20Coach",
      highlighted: false,
      visible: true,
    },
  ],
}
