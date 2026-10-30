# Google Drive integration

Users connect their own Google account (read-only), browse their Drive folder by folder,
and import files into Documents. Google Docs/Slides/Drawings are exported as PDF and
Sheets as `.xlsx`; files over 25 MB are rejected.

```
Browser ──"Connect"──► GET /integrations/google-drive/auth-url ──► Google consent screen
   ▲                                                                     │
   └── /integrations/google-drive/callback?code&state ◄──────────────────┘
          │
          └─► POST /integrations/google-drive/connect { code, state }
                 backend verifies the signed state, exchanges the code with the client
                 secret, stores the refresh token AES-256-GCM encrypted per user
```

Scopes: `drive.readonly`, `openid`, `email`. Nothing is ever written to the user's Drive.

**Google Calendar** uses the same OAuth client and the same redirect URI, with its own
consent and tokens (scope `calendar.events`). The signed `state` says which integration
started the sign-in, and the callback page finishes the right one. To enable it, also turn on
the **Google Calendar API** (step 2 below) and add `.../auth/calendar.events` to the consent
screen's scopes (step 3).

## 1. Create the Google OAuth client (one time, ~10 minutes)

1. Open <https://console.cloud.google.com/> and create a project (e.g. "iamcandidate").
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**. For Calendar
   sync, also enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**, app name "iamcandidate", your email as support and developer contact.
   - **Data access / Scopes**: add `.../auth/drive.readonly`, `openid`, `.../auth/userinfo.email`,
     and `.../auth/calendar.events` for Calendar sync.
   - **Audience → Test users**: add every Google account that will connect (e.g. your Gmail).
     While the app is in _Testing_, only these accounts can sign in.
4. **Clients → Create client** → type **Web application**:
   - **Authorized redirect URIs**:
     - `http://localhost:3000/integrations/google-drive/callback` (local)
     - `https://<your-frontend-domain>/integrations/google-drive/callback` (production)
   - Create, then copy the **Client ID** and **Client secret**.

## 2. Configure the backend

**`npm run dev`** — add to `iamcandidate-server/.env` (git-ignored), then restart:

```bash
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REDIRECT_URI=http://localhost:3000/integrations/google-drive/callback
```

The startup banner shows `Google Drive enabled`.

**`sam local`** — put the same three values in `env.local.json` (don't commit the secret).

**AWS** — pass the stack parameters `GoogleClientId`, `GoogleClientSecret` and
`GoogleRedirectUri` (`sam deploy --guided` asks for them). Leave them empty to disable the
feature.

## 3. Connect

Integrations → Google Drive → **Connect** → **Continue to Google** → pick your account →
allow. You land back on the Drive page and can browse and **Add to Docs**.

## Notes and limits

- **Testing mode:** Google expires refresh tokens of apps in _Testing_ status after 7 days
  when they use Drive scopes. The app then shows "Google Drive access has expired… Reconnect"
  and you connect again. Publishing the app removes this, but `drive.readonly` is a
  _restricted_ scope that needs Google's verification (and a security assessment) for public
  apps — for personal use, staying in Testing is the practical choice.
- **"Google hasn't verified this app"** appears for unpublished apps: choose _Continue_.
- **Disconnect** revokes the grant at Google and deletes the stored tokens.
- Imported files are copies; later changes in Drive aren't synced back.
- Tokens are re-read and refreshed server-side; the browser never sees them.

## Troubleshooting

| Message                                                        | Fix                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| "Google Drive isn't set up on this server yet"                 | Set the three `GOOGLE_*` values and restart the backend.                                 |
| Google shows `redirect_uri_mismatch`                           | The redirect URI must match the OAuth client's entry exactly (scheme, host, port, path). |
| Google shows "Access blocked … has not completed verification" | Add your account under **Audience → Test users**.                                        |
| "This Google sign-in has expired or wasn't started here"       | The sign-in took over 10 minutes or was opened in another session — connect again.       |
| "Google didn't grant offline access"                           | Remove iamcandidate at <https://myaccount.google.com/permissions> and connect again.      |
