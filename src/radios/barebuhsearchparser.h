/*
 * Strawberry Music Player
 * Copyright 2026, Barebuh contributors
 *
 * Strawberry is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

#ifndef BAREBUHSEARCHPARSER_H
#define BAREBUHSEARCHPARSER_H

#include <QByteArray>
#include <QString>

#include "radiochannel.h"

struct BarebuhSearchResult {
  RadioChannelList channels;
  QString error;
  bool valid = false;
};

class BarebuhSearchParser {
 public:
  static constexpr qsizetype kMaximumResponseBytes = 64 * 1024;
  static constexpr qsizetype kMaximumItems = 64;

  static bool IsValidIJson(const QByteArray &data, qsizetype maximum_bytes);
  static BarebuhSearchResult Parse(const QByteArray &data);
};

#endif  // BAREBUHSEARCHPARSER_H
