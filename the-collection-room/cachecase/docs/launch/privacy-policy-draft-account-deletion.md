# Proposed privacy-policy language: account deletion, data export and retention

**Status:** DRAFT for legal review. It has not been reviewed or approved, and no legal compliance (GDPR, CCPA/CPRA, app-store rules or any other) is claimed or certified.

- **[LEGAL REVIEW]** marks a statement whose wording or basis needs a lawyer's confirmation.
- **[CONFIRM]** marks a fact to re-check against production before publishing.

These sections are written to slot into the existing CacheCase privacy policy. They describe what the system does as built in Dashboard Milestone 2, Checkpoints 1–5.

---

## Deleting your account

You can delete your CacheCase account at any time from **Dashboard → Delete Account**. To protect your account, we ask for your password and for you to type DELETE to confirm. There are two ways to delete.

### Delete after 14 days (with a recovery period)

1. **When you choose this,** your account is hidden immediately:
   - your profile, collections, items, Grails, posts, comments and messages are no longer visible to anyone;
   - you can't post, message, follow, tag or upload;
   - we sign you out on your other devices.
2. **For 14 days nothing is deleted.** Sign in during that time and choose **Cancel Deletion**, and your account is restored as it was.
3. **After 14 days,** permanent deletion begins automatically and can no longer be cancelled. Your account is then deleted as described under *What permanent deletion removes*.

**[LEGAL REVIEW]** Confirm that the 14-day period, and the account being hidden but not deleted during it, are adequately disclosed for any jurisdiction-specific "right to erasure" response deadlines.

### Delete permanently now

You can skip the recovery period. Permanent deletion then starts straight away and cannot be cancelled or undone. It usually finishes within minutes. If it takes longer, your account stays hidden until it is finished.

## What permanent deletion removes

When your account is permanently deleted, we delete:
- **your account and sign-in details:** email address, password credentials and sessions;
- **your profile:** username, display name, bio, avatar and banner;
- **your collections and items,** with their details and the **photos you uploaded**;
- **your Grails, posts, comments, likes, saves and follows,** and the tags you created or received;
- **your notifications;**
- **the messages you sent, and photos you attached to them;**
- **any Download My Data archives** you prepared;
- **your waitlist record.**

**[LEGAL REVIEW]** We found no documented legal obligation to keep waitlist records, so they are deleted. Confirm before publishing.

## Other collectors' content

- **Posts that share your items or collections.** If another collector shared one of your items or collections in their own post, we remove the copy of your photo and your item details from their post. Their post, their own words and anything else it contains stay, with a note that the shared item is no longer available.
- **Posts that quote or repost yours.** Other collectors' quotes of your posts stay, showing your original as unavailable. Their reposts of your posts, and the comments and likes others left on your posts, are deleted along with your posts.
  - **[LEGAL REVIEW]** This removes other collectors' comments on your posts. Confirm this is acceptable and is disclosed to them, for example in the Terms.
- **Direct messages.** Messages other collectors sent you stay in their inbox. The conversation then shows as "Deleted account" and becomes read-only: nobody can send new messages in it.

## Information we keep after deletion

- **Username reservation.** For 90 days after deletion, your former username can't be registered by anyone. To enforce this we keep a keyed cryptographic fingerprint (HMAC) of the username, not the username itself. The fingerprint is deleted after 90 days.
  - **[LEGAL REVIEW]** A keyed fingerprint can be matched against a guessed username by anyone holding the key. Confirm whether it counts as personal data under applicable law, and whether 90 days is justified (preventing impersonation).
- **Deletion records.** We keep a minimal technical record of each deletion for 30 days after it completes, so we can confirm it finished and investigate problems. The record holds:
  - an internal account identifier;
  - dates and times;
  - processing status;
  - file counts;
  - error codes, if any.

  It does not include your email address or username. After 30 days the record is deleted.
  - If a deletion fails, its record is kept until our team has finished the deletion.
- **Collectible registry and transfer history** *(features not yet available in the beta; included so the policy stays accurate when they launch)*:
  - **Registered collectibles you still own** are marked as belonging to a deleted account and made private, and their registry photos are deleted.
  - **The collectible's registry record and ownership history** stay, with your identity removed. That record holds the Cache ID, the item's title and description, and the dates of past events.
  - **Collectibles you had already transferred to someone else** are unaffected.
  - **Pending transfers to or from you** are cancelled.
  - **[LEGAL REVIEW]** This history may still describe an item you once owned, and the dates of its events. Confirm the basis for keeping it (record integrity for other owners) and whether it needs separate disclosure.
- **Backups.** Our database is backed up daily, and backups are kept for 7 days **[CONFIRM: current production setting, 7 days, point-in-time recovery off]**. Deleted information can remain in these backups until they expire, at most 7 days after deletion.
  - Backups are used only to recover from failures.
  - If we ever restore one, we will re-apply deletions completed since that backup.
  - **[LEGAL REVIEW]** Confirm the wording on backups, and the commitment to re-apply deletions after a restore.

## Links and copies that may outlive deletion briefly

- **Download links.** A download link for a Download My Data file stops working within 5 minutes of being created.
- **Private photo links.** Links to private photos stop working within 5 minutes of being created.
- **Public images.** Some images are served from public addresses so the app can show them quickly:
  - profile pictures;
  - images in shared posts.

  After deletion these images are removed from our storage, but copies may remain briefly in content-delivery caches, or on devices that already downloaded them, until those caches expire.
  - **[CONFIRM]** the CDN cache lifetime for public Storage objects.
  - **[LEGAL REVIEW]** Confirm the wording.
- **Copies others made.** We can't delete copies of your content that other people saved outside CacheCase, such as screenshots.

## Download My Data

You can download a copy of your data at any time from **Dashboard → Download My Data**, including while your account is scheduled for deletion. The download is unavailable once permanent deletion has started.

- **What's included:**
  - your profile;
  - collections and items, with their details;
  - your photos;
  - Grails;
  - posts and comments;
  - the messages you sent;
  - other records about you.
- **What's not included:**
  - messages other collectors sent you;
  - photos attached to direct messages;
  - other collectors' content.
- **The file format:**
  - your data comes as one or more ZIP files, each of which opens on its own;
  - large exports are split into parts;
  - the included `manifest.json` lists every part and which part holds each file.
- **For your security:**
  - preparing a download requires a recent sign-in;
  - your archive is stored privately, and only you can get a link to it;
  - each link works for 5 minutes;
  - the archive is deleted automatically after 7 days, or when you request a new one or delete your account;
  - an export that is started but never finished is cleaned up within about a day.

**[LEGAL REVIEW]** Confirm whether the export's scope and format meet data-portability requirements where they apply (for example, structured, commonly used, machine-readable).

## Contact

For questions about deleting your account, your data or this policy, email **info@cachecase.com**. The same address appears in the app under **Dashboard → Support & Contact**, and on screens where a deletion or a Download My Data request fails.

**[LEGAL REVIEW]** Confirm whether a postal address, a named data-protection contact, or a separate privacy-request channel is also required where the policy applies.
