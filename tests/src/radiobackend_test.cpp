/*
 * Strawberry Music Player
 * Copyright 2026, Barebuh contributors
 *
 * Strawberry is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

#include <algorithm>
#include <memory>

#include "gtest_include.h"

#include <QSignalSpy>

#include "core/memorydatabase.h"
#include "radios/radiobackend.h"

using namespace Qt::Literals::StringLiterals;
using std::make_shared;

namespace {

RadioChannel Channel(const Song::Source source, const QString &name, const QString &url) {
  return RadioChannel(source, name, QUrl(url));
}

RadioChannelList ReadChannels(RadioBackend *backend) {
  QSignalSpy spy(backend, &RadioBackend::NewChannels);
  backend->GetChannelsAsync();
  if (!spy.wait()) return {};
  return spy.first().first().value<RadioChannelList>();
}

}  // namespace

TEST(RadioBackendTest, ReplacesOnlyOneSourceAndDeduplicatesUrls) {
  const SharedPtr<Database> database = make_shared<MemoryDatabase>(nullptr);
  RadioBackend backend(database);

  QSignalSpy replaced(&backend, &RadioBackend::ChannelsReplaced);
  backend.ReplaceChannelsAsync(Song::Source::SomaFM, {Channel(Song::Source::SomaFM, u"Soma"_s, u"https://soma.example/live"_s)});
  ASSERT_TRUE(replaced.wait());

  const RadioChannel duplicate = Channel(Song::Source::Barebuh, u"Duplicate"_s, u"https://barebuh.example/live"_s);
  backend.ReplaceChannelsAsync(Song::Source::Barebuh, {Channel(Song::Source::Barebuh, u"Original"_s, u"https://barebuh.example/live"_s), duplicate});
  ASSERT_TRUE(replaced.wait());

  const RadioChannelList channels = ReadChannels(&backend);
  ASSERT_EQ(2, channels.size());
  EXPECT_EQ(1, std::count_if(channels.cbegin(), channels.cend(), [](const RadioChannel &channel) { return channel.source == Song::Source::SomaFM; }));
  EXPECT_EQ(1, std::count_if(channels.cbegin(), channels.cend(), [](const RadioChannel &channel) { return channel.source == Song::Source::Barebuh; }));
}

TEST(RadioBackendTest, ValidEmptyReplaceDoesNotDeleteOtherSources) {
  const SharedPtr<Database> database = make_shared<MemoryDatabase>(nullptr);
  RadioBackend backend(database);

  QSignalSpy replaced(&backend, &RadioBackend::ChannelsReplaced);
  backend.ReplaceChannelsAsync(Song::Source::SomaFM, {Channel(Song::Source::SomaFM, u"Soma"_s, u"https://soma.example/live"_s)});
  ASSERT_TRUE(replaced.wait());
  backend.ReplaceChannelsAsync(Song::Source::Barebuh, {});
  ASSERT_TRUE(replaced.wait());

  const RadioChannelList channels = ReadChannels(&backend);
  ASSERT_EQ(1, channels.size());
  EXPECT_EQ(Song::Source::SomaFM, channels.first().source);
}

TEST(RadioBackendTest, ExpiredCachedHealthBecomesUnknown) {
  const SharedPtr<Database> database = make_shared<MemoryDatabase>(nullptr);
  RadioBackend backend(database);
  RadioChannel channel = Channel(Song::Source::Barebuh, u"Cached"_s, u"https://barebuh.example/live"_s);
  channel.health = u"ok"_s;
  channel.health_expires_at = 1;

  QSignalSpy replaced(&backend, &RadioBackend::ChannelsReplaced);
  backend.ReplaceChannelsAsync(Song::Source::Barebuh, {channel});
  ASSERT_TRUE(replaced.wait());

  const RadioChannelList channels = ReadChannels(&backend);
  ASSERT_EQ(1, channels.size());
  EXPECT_EQ(u"unknown"_s, channels.first().health);
}
