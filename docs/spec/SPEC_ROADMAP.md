# Spec Roadmap

> Auto-updated index. Last updated: 2026-09-18 13:40
>
> **AI Agents**: Read this file first to decide which specs to load. Load only what's relevant to your task to avoid context bloat.

## Module Index

| Module | Spec | Domain Layer | Description | Sub-modules |
|--------|------|--------------|-------------|-------------|
| yazi-explorer | [yazi-explorer.spec.md](./yazi-explorer.spec.md) | Core Domain | Keyboard-driven miller-column file explorer for Obsidian: one modal with a layer stack for navigation, sanitised markdown preview, and configuration-driven openers / decorations / facets / relations / saved views. | — |

## Loading Guide

| Task Type | Load These Specs |
|-----------|-----------------|
| 實作特定子模組功能 | 該子模組 spec + parent spec |
| 跨模組整合 | 相關模組各自的 root spec |
| 第一次理解系統 | 先讀本 SPEC_ROADMAP，再按需載入 |

## Recent Feature Changes

| Date | Module | Feature SRS | One-line Summary |
|------|--------|-------------|-----------------|
| 2026-09-18 12:18 | yazi-explorer | — | Created from brownfield analysis (code-sync) at v0.1.0 — outline, relations, saved views and the unified h/Esc/q layer stack |
