import type { ApplicationStatus, InterviewType } from "."

/** Display labels used in activity titles (same wording as the frontend). */
export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  wishlist: "Wishlist",
  applied: "Applied",
  recruiter: "Recruiter",
  technical: "Technical Interview",
  hr: "HR",
  offer: "Offer",
  rejected: "Rejected",
}

export const INTERVIEW_TYPE_LABELS: Record<InterviewType, string> = {
  recruiter_screen: "Recruiter screen",
  technical: "Technical",
  system_design: "System design",
  behavioral: "Behavioral",
  hr: "HR",
  final: "Final round",
}
