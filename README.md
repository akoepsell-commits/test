# Avery & Kodie's Wedding

The wedding planner plus a public RSVP page, running on Netlify.

- **Guests** see the RSVP page and can RSVP without an account.
- **Avery and Kodie** sign in with a shared passcode. Everything syncs live between you within a few seconds: venue picks, food, drinks, music, budget, notes, guest list, mood board photos and activity.
- The **guest list is always private**. Turn on "Let visitors see our planning" in ⚙ Site settings if you want guests to browse the plan (view only).

## What's in the folder

```
public/index.html            the whole site
netlify/functions/api.mjs    the backend (saving, syncing, photos, RSVPs)
netlify.toml                 tells Netlify where things are
package.json                 the one library the backend needs (@netlify/blobs)
```

Data and photos are stored in **Netlify Blobs**, which is part of your Netlify site. You don't need a separate database.

## Deploy it (about 10 minutes)

Netlify's drag-and-drop deploy **doesn't support functions**, so use GitHub (option A) or the Netlify command line (option B).

### Option A: GitHub (easiest, and it updates automatically)

1. Make a free GitHub account, then click **New repository**. Name it `wedding` and keep it **Private**.
2. On the new repo page, click **uploading an existing file**. Drag in everything from this folder (the `public` and `netlify` folders, `netlify.toml`, `package.json` and this README), then click **Commit changes**.
3. In Netlify, click **Add new project** (older screens say **Add new site**) **→ Import an existing project → GitHub** and pick the `wedding` repo. The settings fill in from `netlify.toml`. Click **Deploy**.
4. **Set your passcode:** in Netlify go to **Project configuration** (or **Site configuration**) **→ Environment variables → Add a variable**. Set the key to `EDIT_PASSCODE` and the value to a passcode only you and Kodie know. Save.
5. Go to **Deploys → Trigger deploy → Deploy site** so the passcode takes effect.
6. Open your site, tap **"Avery or Kodie? Sign in,"** pick your name and enter the passcode. Send Kodie the link and the passcode.

To change the site later, upload the new `index.html` to the repo and Netlify redeploys on its own.

### Option B: Netlify CLI

```bash
npm install -g netlify-cli
cd wedding-site
npm install
netlify login
netlify init                 # create a new site
netlify env:set EDIT_PASSCODE "your-passcode"
netlify deploy --build --prod
```

## Using it

- **Sign in:** use the button at the top right. Your name shows up in the activity feed ("Kodie added 3 photos to Flowers").
- **⚙ Site settings:** set the date, the welcome message and the RSVP deadline, open or close RSVPs, and choose whether visitors can see your planning.
- **RSVPs:** share the site link. When a guest RSVPs, their name is matched to your guest list, so add guests using the names you'll put on the invitations. A name with no match is added as a new guest in the "RSVP form" group.
- **Mood board:** add photos from your phone or computer. Big photos are shrunk automatically.
- **Copy list for Excel** on the Guests tab copies the whole list, RSVP messages and song requests included.

## Costs

The Netlify free plan should cover a wedding site with normal traffic. Each open browser checks for updates every 4 seconds (every 30 seconds when the tab is in the background), and that uses a small amount of your monthly allowance. Check **Usage** in Netlify now and then.

## Privacy notes

- The guest list and activity feed are only sent to someone who has the passcode.
- Mood board photos use long random links, so they can't be guessed. Anyone who has a photo's exact link can still open it.
- To change the passcode, update `EDIT_PASSCODE` and redeploy. Everyone will need to sign in again.
