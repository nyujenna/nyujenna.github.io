# Color Choice Video Study

Local JavaScript app for running a single-video study:
- One video plays per trial
- After video ends, participant selects `cyan` or `red`
- Choice is logged per user/session

## Video Root and Layout
Default video root is `out_triplets/`.

Expected structure:
- `out_triplets/<base_video_id>/triplets/*.mp4`

Example:
- `out_triplets/125/triplets/tri_000_..._cyan__c_..._red.mp4`

Override root with env var:
```bash
STUDY_VIDEO_ROOT=out_h264 npm start
```

## Start Inputs
- `User ID` is required.
- Trials are auto-discovered from `<video_root>/*/triplets/*.mp4`.

## Run
```bash
npm start
```
Open `http://localhost:3000`.

## Study Controls
- After each video ends, choose color:
  - `C` key or "Choose Cyan" button
  - `R` key or "Choose Red" button
- Press `Space` to continue to the next trial after saving.

## API
- `POST /api/session/start`
  - Body: `{ "userId": "P001" }`
- `GET /api/session/:sessionId/next`
- `POST /api/session/:sessionId/answer`
  - Body: `{ "trialId": "...", "choiceColor": "cyan", "rtMs": 1234 }`
- `POST /api/session/:sessionId/complete`

## Log Format
Output: `data/logs/<userId>_<YYYYMMDD_HHMMSS>.csv`

Columns:
- `session_id`
- `user_id`
- `trial_index`
- `trial_id`
- `base_video_id`
- `video_path`
- `unet_label`
- `unet_color`
- `compare_label`
- `compare_color`
- `choice_color`
- `rt_ms`
- `answered_at_iso`
