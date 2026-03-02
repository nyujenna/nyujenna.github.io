# 2AFC Video Study App

Local JavaScript app for running 2AFC user studies with simultaneous playback:
- GT reference on top
- Two model outputs below (left/right)
- Participant chooses preference with `1` (left) or `2` (right)

## Current Trial Logic
- Video source root: `out/`
- A valid base video must contain:
  - `tpp*` folder with a `gt_only/*.mp4` (GT)
  - `tpp*` prediction `.mp4`
  - `diffeye*` prediction `.mp4`
  - `unet*` prediction `.mp4`
- The app builds trials as:
  - 8 base videos
  - 2 comparisons each (`unet vs tpp`, `unet vs diffeye`)
  - Total: **16 trials**
- Left/right position is randomized per trial.
- Videos are served directly from `out/` as MP4 sources.

## Start Inputs
- `User ID` is required.
- Trials are always auto-discovered from `out/`.

## Install
No external dependencies are required.

## Run
```bash
npm start
```
Open `http://localhost:3000`.

## Fast Offline Conversion (Recommended)
If browser cannot play your `out/*.mp4` (codec `mp4v`), convert once to H.264:

```bash
python3 scripts/convert_out_to_h264.py --input-root out --output-root out_h264 --workers 8
```

Then run the app against converted videos:

```bash
STUDY_VIDEO_ROOT=out_h264 npm start
```

## API
- `POST /api/session/start`
  - Body: `{ "userId": "P001" }`
- `GET /api/session/:sessionId/next`
- `POST /api/session/:sessionId/answer`
  - Body: `{ "trialId": "...", "choice": 1, "rtMs": 1234 }`
- `POST /api/session/:sessionId/complete`

## Log Format
Output: `data/logs/<userId>_<YYYYMMDD_HHMMSS>.csv`

Columns:
- `session_id`
- `user_id`
- `trial_index`
- `trial_id`
- `base_video_id`
- `gt_video`
- `unet_video`
- `opponent_model`
- `opponent_video`
- `left_source`
- `right_source`
- `left_video`
- `right_video`
- `choice`
- `chosen_source`
- `rt_ms`
- `answered_at_iso`
# scanpath_2afc
