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

#include <QDateTime>
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

TEST(RadioBackendTest, PreservesCompleteBarebuhMetadataAcrossReload) {
  const SharedPtr<Database> database = make_shared<MemoryDatabase>(nullptr);
  RadioChannel channel = Channel(Song::Source::Barebuh, u"Cached"_s, u"https://barebuh.example/live"_s);
  channel.country = u"FI"_s;
  channel.tags = u"jazz, live"_s;
  channel.codec = u"opus"_s;
  channel.station_id = u"oradio:station:ed25519:abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"_s;
  channel.provenance = u"[]"_s;
  channel.policy_state = u"admitted"_s;
  channel.health = u"ok"_s;
  channel.forked = true;
  channel.refreshed_at = 100;
  channel.indexed_at = 101;
  channel.last_replication_at = 102;
  channel.health_expires_at = QDateTime::currentSecsSinceEpoch() + 3600;

  {
    RadioBackend writer(database);
    QSignalSpy replaced(&writer, &RadioBackend::ChannelsReplaced);
    writer.ReplaceChannelsAsync(Song::Source::Barebuh, {channel});
    ASSERT_TRUE(replaced.wait());
  }
  RadioBackend reader(database);
  const RadioChannelList channels = ReadChannels(&reader);
  ASSERT_EQ(1, channels.size());
  const RadioChannel &cached = channels.first();
  EXPECT_EQ(channel.country, cached.country);
  EXPECT_EQ(channel.tags, cached.tags);
  EXPECT_EQ(channel.codec, cached.codec);
  EXPECT_EQ(channel.station_id, cached.station_id);
  EXPECT_EQ(channel.provenance, cached.provenance);
  EXPECT_EQ(channel.policy_state, cached.policy_state);
  EXPECT_EQ(channel.health, cached.health);
  EXPECT_EQ(channel.forked, cached.forked);
  EXPECT_EQ(channel.refreshed_at, cached.refreshed_at);
  EXPECT_EQ(channel.indexed_at, cached.indexed_at);
  EXPECT_EQ(channel.last_replication_at, cached.last_replication_at);
  EXPECT_EQ(channel.health_expires_at, cached.health_expires_at);
  EXPECT_TRUE(cached.offline);
}

TEST(RadioBackendTest, InvalidReplacementPreservesLastKnownGoodRows) {
  const SharedPtr<Database> database = make_shared<MemoryDatabase>(nullptr);
  RadioBackend backend(database);
  QSignalSpy replaced(&backend, &RadioBackend::ChannelsReplaced);
  backend.ReplaceChannelsAsync(Song::Source::Barebuh, {Channel(Song::Source::Barebuh, u"Good"_s, u"https://barebuh.example/good"_s)});
  ASSERT_TRUE(replaced.wait());
  backend.ReplaceChannelsAsync(Song::Source::Barebuh, {Channel(Song::Source::SomaFM, u"Wrong source"_s, u"https://barebuh.example/bad"_s)});
  EXPECT_FALSE(replaced.wait(100));
  const RadioChannelList channels = ReadChannels(&backend);
  ASSERT_EQ(1, channels.size());
  EXPECT_EQ(u"Good"_s, channels.first().name);
}
