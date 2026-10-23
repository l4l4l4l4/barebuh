# Copyright 2026 Barebuh contributors
# SPDX-License-Identifier: GPL-3.0-or-later

file(STRINGS "${CMAKE_SOURCE_DIR}/release/VERSION" BAREBUH_VERSION LIMIT_COUNT 1)
if(NOT BAREBUH_VERSION MATCHES "^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?$")
  message(FATAL_ERROR "Invalid Barebuh version in release/VERSION: ${BAREBUH_VERSION}")
endif()

set(BAREBUH_PRODUCT_NAME "Barebuh")
set(BAREBUH_DISPLAY_NAME "Barebuh Music Player")
set(BAREBUH_EXECUTABLE_NAME "barebuh")
set(BAREBUH_APPLICATION_ID "org.barebuh.Barebuh")
set(BAREBUH_ORGANIZATION_NAME "Barebuh")
set(BAREBUH_ORGANIZATION_DOMAIN "org.barebuh")

set(STRAWBERRY_VERSION_DISPLAY "${BAREBUH_VERSION} (Strawberry ${majorminorpatch} base)")
set(STRAWBERRY_VERSION_PACKAGE "${BAREBUH_VERSION}")
string(REPLACE "-" "~" STRAWBERRY_VERSION_RPM_V "${BAREBUH_VERSION}")
set(STRAWBERRY_VERSION_RPM_R "1")

option(BAREBUH_ENABLE_UPDATES "Enable a configured Barebuh update feed" OFF)
if(BAREBUH_ENABLE_UPDATES)
  message(FATAL_ERROR "Barebuh update feeds are not configured; BAREBUH_ENABLE_UPDATES must remain OFF")
endif()

message(STATUS "Barebuh Version:")
message(STATUS "Display:  ${STRAWBERRY_VERSION_DISPLAY}")
message(STATUS "Package:  ${STRAWBERRY_VERSION_PACKAGE}")
message(STATUS "RPM:      ${STRAWBERRY_VERSION_RPM_V}-${STRAWBERRY_VERSION_RPM_R}")
