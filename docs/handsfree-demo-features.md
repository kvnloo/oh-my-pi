# Handsfree / Stage Manager — Demo Feature Checklist

Source: `/tmp/maxblade-handsfree/demo-720.mp4` (MaxBlade / JEV LIVE reference capture, ~84s).

Use this as the acceptance checklist for OMP Handsfree on Hyprland.

## HUD / Chrome

| # | Feature | Demo behavior | OMP target |
|---|---------|-----------------|------------|
| H1 | Bottom composer capsule | Dark rounded pill, no hard outline | `app.py` CSS `.capsule` borderless |
| H2 | Live transcript line | Spoken text in bottom bar while voice active | Grok live + HUD status |
| H3 | App switcher chip | Short app class in chip | `_target_combo` |
| H4 | HUD always on top | Floats above workspace; content not covered | `promote_hud_overlay` + bottom reserve |
| H5 | Super+Esc toggle | Show/hide Handsfree bar | `omp-handsfree-binds.lua` |
| H6 | Super+Shift+M voice | Toggle live mic | ctl `voice` |

## Stage Manager (Felix carousel)

| # | Feature | Demo behavior | OMP target |
|---|---------|-----------------|------------|
| S1 | Centered active window | Large card with outer gaps | `HandsfreeCarousel` center slot |
| S2 | Left/right peeks | Neighbors partially visible | L/R slots |
| S3 | Focus/switch app | Returns to stage view | `_enter_stage_view` |
| S4 | Next/previous | Carousel rotate | `_carousel_rotate` |
| S5 | Restore from quad | Back to carousel from 2x2 | `stage_restore` + `ctl stage` |
| S6 | Auto-open on start | Stage on HUD boot | `OMP_HANDSFREE_AUTO_STAGE=1` |

## Multi-layout

| # | Feature | Demo behavior | OMP target |
|---|---------|-----------------|------------|
| L1 | 2x2 quadrant split | Four equal tiles | `layout_quadrants` |
| L2 | Above HUD | Bottom row not under capsule | `compute_quadrant_slots` |
| L3 | Tile / ungroup | Native tiled mode | `tile_windows` |
| L4 | Layout mode | stage / quadrant / native | `_layout_mode` |

## Voice hotpath

| # | Feature | Demo behavior | OMP target |
|---|---------|-----------------|------------|
| V1 | Local window switch | No agent for focus/next | `stage_intent` |
| V2 | Local layout macros | Quadrants without agent | `_apply_layout_intent` |
| V3 | Complex -> agent | Not killed as none | ambient defer |

## Tests

- `python3 -m unittest discover -s python/omp-hud/tests -v`
- `./scripts/test-handsfree-layout.py --live`
