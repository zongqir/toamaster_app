# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

用中文和我对话

## Project Overview

Toastmasters meeting timer mini-program ("启航AACTP 时间官") built with Taro 4.1.10 + React 18 + TypeScript. Targets WeChat Mini Program (primary) and H5 web. Features meeting import/parsing, real-time countdown timer, voting, and statistics.

## Commands

- **Lint (primary validation):** `pnpm run lint`
  - Runs Biome check with auto-fix (`--write --unsafe`), then `tsgo` type checking, then ast-grep navigation/icon-path checks, then a test H5 build
- **Install dependencies:** `pnpm install`
- **Dev/build commands are disabled in this environment.** Use `pnpm run lint` to validate code correctness.

## Architecture

### Build & Platform

- Taro cross-platform framework compiling to WeChat Mini Program (`weapp`) and H5
- Vite-based compiler with TailwindCSS + `weapp-tailwindcss` for mini-program compatibility
- `@` path alias maps to `src/`
- Design width: 375px. TailwindCSS rem units are converted to rpx for mini-program via `rem2rpx`
- Supabase client uses `supabase-wechat-js` polyfill for weapp, standard `@supabase/supabase-js` for H5 (aliased in `config/index.ts`)
- `src/client/supabase.ts` is excluded from linting/type-checking (`@ts-nocheck`, excluded in biome.json and tsconfig.check.json)

### State & Data

- **Zustand** for global state (`src/store/meetingStore.ts`) — holds current session and app settings
- **Taro local storage** via `src/services/storage.ts` for persistent data (meetings, settings)
- **Supabase** for backend: database operations in `src/db/`, edge functions in `supabase/functions/`
- **Auth** via React Context (`src/contexts/AuthContext.tsx`) providing `useAuth()` hook — supports username/password, phone OTP, and WeChat login

### Key Directories

- `src/pages/` — each page is a directory with `index.tsx` (history, import, timeline, timer, settings, vote-*, vote-edit, vote-entrance, vote-result)
- `src/components/` — shared components (MeetingStats, CustomTabBar, PasswordModal, RouteGuard)
- `src/hooks/` — `useMeetingTimer` (countdown logic with yellow/red card alerts), `useTabBarPageClass`
- `src/services/` — `parser.ts` (meeting text parsing), `storage.ts` (Taro storage wrapper), `votingService.ts`
- `src/types/` — `meeting.ts` (MeetingItem, MeetingSession, AppSettings), `voting.ts`

### Tab Pages

Tab bar pages defined in `src/app.config.ts`: `history`, `vote-entrance`, `settings`. Navigate to these with `Taro.switchTab()`, never `Taro.navigateTo()`.

## Code Style

- **Biome** for linting and formatting (not ESLint/Prettier)
- Single quotes, no semicolons, no trailing commas, 2-space indent, 120 line width, LF line endings
- Type checking via `tsgo` (native TypeScript checker) with `tsconfig.check.json` — uses `strictNullChecks`

## Important Rules

- **Banned imports** (enforced by Biome): `echarts-for-taro` (doesn't exist), `file-saver` (breaks weapp build — use Taro APIs instead)
- **No absolute icon paths**: `iconPath`/`selectedIconPath` in app.config.ts must not start with `/` (use relative paths)
- **Tab navigation**: Never use `navigateTo()` for tab pages — use `switchTab()`. Enforced by ast-grep rule + `checkNavigation.sh`
- **Environment variables** must be prefixed with `TARO_APP_` to be accessible in code
- **AuthProvider context**: `useAuth()` must be called within an `AuthProvider` wrapper
- In `supabase.auth.onAuthStateChange` callback, do NOT use `await` — use `.then()` to avoid deadlocks
