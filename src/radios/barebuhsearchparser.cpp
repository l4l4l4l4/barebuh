/*
 * Strawberry Music Player
 * Copyright 2026, Barebuh contributors
 *
 * Strawberry is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QJsonValue>
#include <QDateTime>
#include <QRegularExpression>
#include <QSet>
#include <QStringList>
#include <QUrl>

#include "barebuhsearchparser.h"

using namespace Qt::Literals::StringLiterals;

namespace {

bool IsHexDigit(const char character) {
  return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F');
}

class JsonStructureValidator {
 public:
  explicit JsonStructureValidator(const QByteArray &data) : data_(data) {}

  bool Validate() {
    SkipWhitespace();
    if (!ParseValue(0)) return false;
    SkipWhitespace();
    return position_ == data_.size();
  }

 private:
  void SkipWhitespace() {
    while (position_ < data_.size() && (data_.at(position_) == ' ' || data_.at(position_) == '\t' || data_.at(position_) == '\r' || data_.at(position_) == '\n')) ++position_;
  }

  bool Consume(const char character) {
    SkipWhitespace();
    if (position_ >= data_.size() || data_.at(position_) != character) return false;
    ++position_;
    return true;
  }

  bool ParseString(QString *decoded = nullptr) {
    SkipWhitespace();
    if (position_ >= data_.size() || data_.at(position_) != '"') return false;
    const qsizetype start = position_++;
    while (position_ < data_.size()) {
      const unsigned char character = static_cast<unsigned char>(data_.at(position_++));
      if (character == '"') {
        if (decoded) {
          const QJsonDocument string_document = QJsonDocument::fromJson("[" + data_.mid(start, position_ - start) + "]");
          if (!string_document.isArray() || string_document.array().size() != 1 || !string_document.array().first().isString()) return false;
          *decoded = string_document.array().first().toString();
        }
        return true;
      }
      if (character < 0x20) return false;
      if (character != '\\') continue;
      if (position_ >= data_.size()) return false;
      const char escape = data_.at(position_++);
      if (escape == 'u') {
        for (int i = 0; i < 4; ++i) {
          if (position_ >= data_.size() || !IsHexDigit(data_.at(position_))) return false;
          ++position_;
        }
      }
      else if (escape != '"' && escape != '\\' && escape != '/' && escape != 'b' && escape != 'f' && escape != 'n' && escape != 'r' && escape != 't') {
        return false;
      }
    }
    return false;
  }

  bool ParseObject(const int depth) {
    if (!Consume('{')) return false;
    SkipWhitespace();
    if (Consume('}')) return true;
    QSet<QString> keys;
    while (true) {
      QString key;
      if (!ParseString(&key) || keys.contains(key)) return false;
      keys.insert(key);
      if (!Consume(':') || !ParseValue(depth + 1)) return false;
      SkipWhitespace();
      if (Consume('}')) return true;
      if (!Consume(',')) return false;
    }
  }

  bool ParseArray(const int depth) {
    if (!Consume('[')) return false;
    SkipWhitespace();
    if (Consume(']')) return true;
    while (true) {
      if (!ParseValue(depth + 1)) return false;
      SkipWhitespace();
      if (Consume(']')) return true;
      if (!Consume(',')) return false;
    }
  }

  bool ParseValue(const int depth) {
    if (depth > 32) return false;
    SkipWhitespace();
    if (position_ >= data_.size()) return false;
    if (data_.at(position_) == '{') return ParseObject(depth);
    if (data_.at(position_) == '[') return ParseArray(depth);
    if (data_.at(position_) == '"') return ParseString();
    static const QList<QByteArray> literals = {QByteArray("true"), QByteArray("false"), QByteArray("null")};
    for (const QByteArray &literal : literals) {
      if (data_.mid(position_, literal.size()) == literal) {
        position_ += literal.size();
        return true;
      }
    }
    const qsizetype start = position_;
    while (position_ < data_.size() && data_.at(position_) != ',' && data_.at(position_) != ']' && data_.at(position_) != '}' && data_.at(position_) != ' ' && data_.at(position_) != '\t' && data_.at(position_) != '\r' && data_.at(position_) != '\n') ++position_;
    return position_ > start;
  }

  const QByteArray &data_;
  qsizetype position_ = 0;
};

BarebuhSearchResult Invalid(const QString &error) {
  BarebuhSearchResult result;
  result.error = error;
  return result;
}

bool IsBoundedText(const QString &text, const qsizetype maximum, const bool allow_empty = false) {
  if ((!allow_empty && text.trimmed().isEmpty()) || text.size() > maximum) return false;
  for (const QChar character : text) {
    if ((character.category() == QChar::Other_Control && character != u'\t') || character == QChar::ObjectReplacementCharacter) return false;
  }
  return true;
}

bool IsPlaybackUrl(const QUrl &url) {
  return url.isValid() && !url.isRelative() && (url.scheme() == u"http"_s || url.scheme() == u"https"_s) && !url.host().isEmpty() && url.userInfo().isEmpty() && !url.hasFragment();
}

bool IsStationId(const QString &id) {
  static const QRegularExpression expression(u"^oradio:station:ed25519:[A-Za-z0-9_-]{43}$"_s);
  return expression.match(id).hasMatch();
}

bool IsRecordId(const QString &id) {
  static const QRegularExpression expression(u"^sha256:[A-Za-z0-9_-]{43}$"_s);
  return expression.match(id).hasMatch();
}

}  // namespace

bool BarebuhSearchParser::IsValidIJson(const QByteArray &data, const qsizetype maximum_bytes) {
  return !data.isEmpty() && data.size() <= maximum_bytes && QString::fromUtf8(data).toUtf8() == data && JsonStructureValidator(data).Validate();
}

BarebuhSearchResult BarebuhSearchParser::Parse(const QByteArray &data) {

  if (data.isEmpty()) return Invalid(u"The registry returned an empty response."_s);
  if (data.size() > kMaximumResponseBytes) return Invalid(u"The registry response exceeded the size limit."_s);
  if (!IsValidIJson(data, kMaximumResponseBytes)) return Invalid(u"The registry returned invalid I-JSON."_s);

  QJsonParseError parse_error;
  const QJsonDocument document = QJsonDocument::fromJson(data, &parse_error);
  if (parse_error.error != QJsonParseError::NoError || !document.isObject()) return Invalid(u"The registry returned invalid JSON."_s);

  const QJsonObject root = document.object();
  if (!root.value(u"items"_s).isArray() || !root.value(u"has_more"_s).isBool() || !root.contains(u"next_cursor"_s) || !root.value(u"query_snapshot"_s).isString()) {
    return Invalid(u"The registry returned an invalid search page."_s);
  }
  if (root.value(u"has_more"_s).toBool()) return Invalid(u"The registry result is incomplete; reduce the node's listing size."_s);
  if (!root.value(u"next_cursor"_s).isNull()) return Invalid(u"The final registry page contained an unexpected cursor."_s);
  if (!IsBoundedText(root.value(u"query_snapshot"_s).toString(), 1024)) return Invalid(u"The registry returned an invalid snapshot identifier."_s);

  const QJsonArray items = root.value(u"items"_s).toArray();
  if (items.size() > kMaximumItems) return Invalid(u"The registry returned too many stations."_s);

  BarebuhSearchResult result;
  QSet<QString> urls;
  for (const QJsonValue &value : items) {
    if (!value.isObject()) return Invalid(u"The registry returned an invalid station item."_s);
    const QJsonObject item = value.toObject();
    const QString station_id = item.value(u"station_id"_s).toString();
    if (!IsStationId(station_id)) return Invalid(u"The registry returned an invalid station identity."_s);
    const QString winning_record_id = item.value(u"winning_record_id"_s).toString();
    const QJsonArray tips = item.value(u"tips"_s).toArray();
    if (!IsRecordId(winning_record_id) || tips.isEmpty() || tips.size() > 32 || !item.value(u"forked"_s).isBool() || !item.value(u"station"_s).isObject() || (!item.value(u"provenance"_s).isArray() && !item.value(u"provenance"_s).isObject()) || !item.value(u"health"_s).isObject()) return Invalid(u"The registry returned incomplete station state."_s);
    for (const QJsonValue &tip : tips) {
      if (!tip.isString() || !IsRecordId(tip.toString())) return Invalid(u"The registry returned an invalid station tip."_s);
    }
    const QByteArray provenance = QJsonDocument::fromVariant(item.value(u"provenance"_s).toVariant()).toJson(QJsonDocument::Compact);
    if (provenance.size() > 4096) return Invalid(u"The registry returned oversized provenance."_s);

    const QJsonObject station = item.value(u"station"_s).toObject();
    const QString name = station.value(u"name"_s).toString().trimmed();
    if (!IsBoundedText(name, 512) || !station.value(u"streams"_s).isArray()) return Invalid(u"The registry returned invalid station metadata."_s);

    const QJsonArray streams = station.value(u"streams"_s).toArray();
    if (streams.isEmpty() || streams.size() > 32) return Invalid(u"The registry returned an invalid stream list."_s);

    QUrl selected_url;
    QString selected_codec;
    for (const QJsonValue &stream_value : streams) {
      if (!stream_value.isObject()) return Invalid(u"The registry returned an invalid stream."_s);
      const QJsonObject stream = stream_value.toObject();
      const QUrl stream_url(stream.value(u"url"_s).toString(), QUrl::StrictMode);
      if (!IsPlaybackUrl(stream_url) || stream.value(u"transport"_s).toString() != stream_url.scheme()) return Invalid(u"The registry returned an unsafe stream URL."_s);
      if (selected_url.isEmpty() || (selected_url.scheme() != u"https"_s && stream_url.scheme() == u"https"_s)) {
        selected_url = stream_url;
        selected_codec = stream.value(u"codec"_s).toString().trimmed();
      }
    }

    const QString normalized_url = selected_url.toString(QUrl::FullyEncoded);
    if (urls.contains(normalized_url)) continue;
    urls.insert(normalized_url);

    QStringList tags;
    const QJsonValue tags_value = station.value(u"tags"_s);
    if (!tags_value.isUndefined()) {
      if (!tags_value.isArray() || tags_value.toArray().size() > 64) return Invalid(u"The registry returned invalid station tags."_s);
      for (const QJsonValue &tag_value : tags_value.toArray()) {
        if (!tag_value.isString() || !IsBoundedText(tag_value.toString(), 128)) return Invalid(u"The registry returned invalid station tags."_s);
        tags << tag_value.toString().trimmed();
      }
    }

    RadioChannel channel;
    channel.source = Song::Source::Barebuh;
    channel.name = name;
    channel.url = selected_url;
    channel.country = station.value(u"country"_s).toString().trimmed();
    if (!channel.country.isEmpty() && !QRegularExpression(u"^[A-Z]{2}$"_s).match(channel.country).hasMatch()) return Invalid(u"The registry returned an invalid country code."_s);
    channel.tags = tags.join(u", "_s);
    channel.codec = selected_codec;
    channel.station_id = station_id;
    channel.provenance = QString::fromUtf8(provenance);
    channel.forked = item.value(u"forked"_s).toBool();
    const QJsonObject health = item.value(u"health"_s).toObject();
    channel.health = health.value(u"state"_s).toString();
    channel.health_expires_at = QDateTime::fromString(health.value(u"expires_at"_s).toString(), Qt::ISODate).toSecsSinceEpoch();
    if (channel.health_expires_at <= QDateTime::currentSecsSinceEpoch()) channel.health = u"unknown"_s;
    channel.refreshed_at = QDateTime::currentSecsSinceEpoch();
    result.channels << channel;
  }

  result.valid = true;
  return result;
}
