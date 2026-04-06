# Smartbook

Smartbook is a simple full-stack web app that matches users to sportsbook recommendations in under 60 seconds.

## Run

1. Install Node.js 18+.
2. From this folder, run `npm start`.
3. Open `http://localhost:3000`.

## Admin

- URL: `/admin`
- `ADMIN_PASSWORD` is required before starting the server
- Override port with `PORT`

## Notes

- Data is stored in `data/db.json`.
- The app tracks `quiz_start`, `quiz_complete`, `email_submit`, `results_view`, and `operator_click`.
- Standard UTM parameters are captured from the URL and stored on each lead.
