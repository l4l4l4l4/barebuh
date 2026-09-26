/*
 * Strawberry Music Player
 * Copyright 2021, Jonas Kvinge <jonas@jkvinge.net>
 *
 * Strawberry is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Strawberry is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Strawberry.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

#include <QtGlobal>
#include <QObject>
#include <QThread>
#include <QMutexLocker>
#include <QSqlDatabase>
#include <QSet>
#include <QDateTime>

#include "includes/shared_ptr.h"
#include "core/database.h"
#include "core/scopedtransaction.h"
#include "core/sqlquery.h"
#include "core/song.h"
#include "radiobackend.h"
#include "radiochannel.h"

using namespace Qt::Literals::StringLiterals;

RadioBackend::RadioBackend(const SharedPtr<Database> db, QObject *parent)
    : QObject(parent),
      db_(db),
      original_thread_(thread()) {}

void RadioBackend::Close() {

  if (db_) {
    QMutexLocker l(db_->Mutex());
    db_->Close();
  }

}

void RadioBackend::ExitAsync() {
  QMetaObject::invokeMethod(this, &RadioBackend::Exit, Qt::QueuedConnection);
}

void RadioBackend::Exit() {

  Q_ASSERT(QThread::currentThread() == thread());

  moveToThread(original_thread_);
  Q_EMIT ExitFinished();

}

void RadioBackend::AddChannelsAsync(const RadioChannelList &channels) {
  QMetaObject::invokeMethod(this, "AddChannels", Qt::QueuedConnection, Q_ARG(RadioChannelList, channels));
}

void RadioBackend::ReplaceChannelsAsync(const Song::Source source, const RadioChannelList &channels) {
  QMetaObject::invokeMethod(this, [this, source, channels]() { ReplaceChannels(source, channels); }, Qt::QueuedConnection);
}

void RadioBackend::ReplaceChannels(const Song::Source source, const RadioChannelList &channels) {

  QMutexLocker l(db_->Mutex());
  QSqlDatabase db(db_->Connect());
  ScopedTransaction transaction(&db);

  SqlQuery delete_query(db);
  delete_query.prepare(u"DELETE FROM radio_channels WHERE source = :source"_s);
  delete_query.BindValue(u":source"_s, static_cast<int>(source));
  if (!delete_query.Exec()) {
    db_->ReportErrors(delete_query);
    return;
  }

  SqlQuery insert_query(db);
  insert_query.prepare(u"INSERT INTO radio_channels (source, name, url, thumbnail_url, country, tags, codec, station_id, provenance, policy_state, health, forked, refreshed_at, indexed_at, last_replication_at, health_expires_at) VALUES (:source, :name, :url, :thumbnail_url, :country, :tags, :codec, :station_id, :provenance, :policy_state, :health, :forked, :refreshed_at, :indexed_at, :last_replication_at, :health_expires_at)"_s);
  QSet<QString> urls;
  for (const RadioChannel &channel : channels) {
    if (channel.source != source) return;
    const QString url = channel.url.toString(QUrl::FullyEncoded);
    if (urls.contains(url)) continue;
    urls.insert(url);
    insert_query.BindValue(u":source"_s, static_cast<int>(channel.source));
    insert_query.BindValue(u":name"_s, channel.name);
    insert_query.BindValue(u":url"_s, channel.url);
    insert_query.BindValue(u":thumbnail_url"_s, channel.thumbnail_url);
    insert_query.BindValue(u":country"_s, channel.country);
    insert_query.BindValue(u":tags"_s, channel.tags);
    insert_query.BindValue(u":codec"_s, channel.codec);
    insert_query.BindValue(u":station_id"_s, channel.station_id);
    insert_query.BindValue(u":provenance"_s, channel.provenance);
    insert_query.BindValue(u":policy_state"_s, channel.policy_state);
    insert_query.BindValue(u":health"_s, channel.health);
    insert_query.BindValue(u":forked"_s, channel.forked);
    insert_query.BindValue(u":refreshed_at"_s, channel.refreshed_at);
    insert_query.BindValue(u":indexed_at"_s, channel.indexed_at);
    insert_query.BindValue(u":last_replication_at"_s, channel.last_replication_at);
    insert_query.BindValue(u":health_expires_at"_s, channel.health_expires_at);
    if (!insert_query.Exec()) {
      db_->ReportErrors(insert_query);
      return;
    }
  }

  transaction.Commit();
  Q_EMIT ChannelsReplaced(source);
}

void RadioBackend::AddChannels(const RadioChannelList &channels) {

  QMutexLocker l(db_->Mutex());
  QSqlDatabase db(db_->Connect());
  ScopedTransaction t(&db);

  SqlQuery q(db);
  q.prepare(u"INSERT INTO radio_channels (source, name, url, thumbnail_url, country, tags, codec, station_id, provenance, policy_state, health, forked, refreshed_at, indexed_at, last_replication_at, health_expires_at) VALUES (:source, :name, :url, :thumbnail_url, :country, :tags, :codec, :station_id, :provenance, :policy_state, :health, :forked, :refreshed_at, :indexed_at, :last_replication_at, :health_expires_at)"_s);

  for (const RadioChannel &channel : channels) {
    q.BindValue(u":source"_s, static_cast<int>(channel.source));
    q.BindValue(u":name"_s, channel.name);
    q.BindValue(u":url"_s, channel.url);
    q.BindValue(u":thumbnail_url"_s, channel.thumbnail_url);
    q.BindValue(u":country"_s, channel.country);
    q.BindValue(u":tags"_s, channel.tags);
    q.BindValue(u":codec"_s, channel.codec);
    q.BindValue(u":station_id"_s, channel.station_id);
    q.BindValue(u":provenance"_s, channel.provenance);
    q.BindValue(u":policy_state"_s, channel.policy_state);
    q.BindValue(u":health"_s, channel.health);
    q.BindValue(u":forked"_s, channel.forked);
    q.BindValue(u":refreshed_at"_s, channel.refreshed_at);
    q.BindValue(u":indexed_at"_s, channel.indexed_at);
    q.BindValue(u":last_replication_at"_s, channel.last_replication_at);
    q.BindValue(u":health_expires_at"_s, channel.health_expires_at);
    if (!q.Exec()) {
      db_->ReportErrors(q);
      return;
    }
  }

  t.Commit();

  Q_EMIT NewChannels(channels);

}

void RadioBackend::GetChannelsAsync() {

  QMetaObject::invokeMethod(this, &RadioBackend::GetChannels, Qt::QueuedConnection);

}

void RadioBackend::GetChannels() {

  QMutexLocker l(db_->Mutex());
  QSqlDatabase db(db_->Connect());

  SqlQuery q(db);
  q.prepare(u"SELECT source, name, url, thumbnail_url, country, tags, codec, station_id, provenance, policy_state, health, forked, refreshed_at, indexed_at, last_replication_at, health_expires_at FROM radio_channels"_s);

  if (!q.Exec()) {
    db_->ReportErrors(q);
    return;
  }

  RadioChannelList channels;
  while (q.next()) {
    RadioChannel channel;
    channel.source = static_cast<Song::Source>(q.value(0).toInt());
    channel.name = q.value(1).toString();
    channel.url.setUrl(q.value(2).toString());
    channel.thumbnail_url.setUrl(q.value(3).toString());
    channel.country = q.value(4).toString();
    channel.tags = q.value(5).toString();
    channel.codec = q.value(6).toString();
    channel.station_id = q.value(7).toString();
    channel.provenance = q.value(8).toString();
    channel.policy_state = q.value(9).toString();
    channel.health = q.value(10).toString();
    channel.forked = q.value(11).toBool();
    channel.refreshed_at = q.value(12).toLongLong();
    channel.indexed_at = q.value(13).toLongLong();
    channel.last_replication_at = q.value(14).toLongLong();
    channel.health_expires_at = q.value(15).toLongLong();
    channel.offline = channel.source == Song::Source::Barebuh;
    if (channel.health_expires_at <= QDateTime::currentSecsSinceEpoch()) channel.health = u"unknown"_s;
    channels << channel;
  }

  Q_EMIT NewChannels(channels);

}

void RadioBackend::DeleteChannelsAsync() {
  QMetaObject::invokeMethod(this, &RadioBackend::DeleteChannels, Qt::QueuedConnection);
}

void RadioBackend::DeleteChannels() {

  QMutexLocker l(db_->Mutex());
  QSqlDatabase db(db_->Connect());

  SqlQuery q(db);
  q.prepare(u"DELETE FROM radio_channels"_s);

  if (!q.Exec()) {
    db_->ReportErrors(q);
  }

}
