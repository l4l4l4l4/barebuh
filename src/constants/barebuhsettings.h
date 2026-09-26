/*
 * Strawberry Music Player
 * Copyright 2026, Barebuh contributors
 *
 * Strawberry is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

#ifndef BAREBUHSETTINGS_H
#define BAREBUHSETTINGS_H

namespace BarebuhSettings {

constexpr char kSettingsGroup[] = "Barebuh";
constexpr char kEnabled[] = "enabled";
constexpr bool kEnabledDefault = false;
constexpr char kEndpoint[] = "endpoint";
constexpr char kEndpointDefault[] = "";
constexpr char kSearchEtag[] = "search_etag";
constexpr char kSearchEtagEndpoint[] = "search_etag_endpoint";

}  // namespace BarebuhSettings

#endif  // BAREBUHSETTINGS_H
