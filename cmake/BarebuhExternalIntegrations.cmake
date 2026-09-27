# Copyright 2026 Barebuh contributors
# SPDX-License-Identifier: GPL-3.0-or-later

if(NOT DEFINED GENIUS_OAUTH_REDIRECT_URL)
  set(GENIUS_OAUTH_REDIRECT_URL "http://localhost")
endif()

if(ENABLE_SPOTIFY)
  if("${SPOTIFY_CLIENT_ID}" STREQUAL "" OR
     "${SPOTIFY_CLIENT_SECRET}" STREQUAL "" OR
     "${SPOTIFY_OAUTH_REDIRECT_URL}" STREQUAL "" OR
     "${SPOTIFY_OAUTH_REDIRECT_URL}" MATCHES "barebuh\\.example" OR
     NOT "${SPOTIFY_OAUTH_REDIRECT_URL}" MATCHES "^(https://|http://(localhost|127\\.0\\.0\\.1)(:|/|$))")
    message(FATAL_ERROR "Spotify requires an explicitly configured OAuth registration: set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and its non-placeholder SPOTIFY_OAUTH_REDIRECT_URL")
  endif()
endif()

if(NOT "${GENIUS_OAUTH_REDIRECT_URL}" MATCHES "^http://(localhost|127\\.0\\.0\\.1)(:|/|$)")
  message(FATAL_ERROR "Genius custom OAuth credentials require a local-loopback GENIUS_OAUTH_REDIRECT_URL")
endif()

if(ENABLE_DISCORD_RPC)
  if("${DISCORD_APPLICATION_ID}" STREQUAL "" OR
     NOT "${DISCORD_APPLICATION_ID}" MATCHES "^[0-9]+$" OR
     "${DISCORD_APPLICATION_ID}" STREQUAL "1352351827206733974")
    message(FATAL_ERROR "Discord Rich Presence requires an approved Barebuh application ID; set a numeric DISCORD_APPLICATION_ID that is not Strawberry's upstream ID")
  endif()
endif()