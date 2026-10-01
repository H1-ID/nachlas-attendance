# NACHLAS Attendance v5

Multi-tenant, multi-Yemot-system attendance dashboard for Vercel + Supabase.

Key design points:
- Tenant isolation by `organization_id` across students, classes, calls, attendance, settings, and audit logs.
- Users may belong to multiple organizations through `organization_members`.
- Each organization may register multiple Yemot systems.
- Each class can map to a specific Yemot system and extension path.
- Yemot API keys are optional and stored encrypted with server-side `ENCRYPTION_KEY`.
- No global `YEMOT_SYSTEM_NUMBER` or `YEMOT_API_KEY` environment variables.

See `README_HE.md` for Hebrew deployment notes.
