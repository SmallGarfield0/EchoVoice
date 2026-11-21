package store

import (
	"sort"

	"github.com/echovoice/echovoice/services/ev-server/internal/domain"
)

type voiceMemberPair struct {
	First  string
	Second string
}

// Active sessions are persisted on every topology change. This checkpoint only
// bounds data loss after an abrupt server stop without creating per-second
// SQLite writes for every active member pair.
const voiceDurationCheckpointIntervalMS int64 = 30_000

func canonicalVoiceMemberPair(first string, second string) (voiceMemberPair, bool) {
	if first == "" || second == "" || first == second {
		return voiceMemberPair{}, false
	}
	if first > second {
		first, second = second, first
	}
	return voiceMemberPair{First: first, Second: second}, true
}

// voiceDurationTopology collapses device-level voice states into member-level
// presence. A member and a member pair are counted at most once per interval.
func voiceDurationTopology(states []domain.VoiceState) (map[string]struct{}, map[voiceMemberPair]struct{}) {
	members := make(map[string]struct{})
	membersByChannel := make(map[string]map[string]struct{})
	for _, state := range states {
		if state.MemberID == "" || state.ChannelID == "" {
			continue
		}
		members[state.MemberID] = struct{}{}
		channelMembers := membersByChannel[state.ChannelID]
		if channelMembers == nil {
			channelMembers = make(map[string]struct{})
			membersByChannel[state.ChannelID] = channelMembers
		}
		channelMembers[state.MemberID] = struct{}{}
	}

	pairs := make(map[voiceMemberPair]struct{})
	for _, channelMembers := range membersByChannel {
		memberIDs := make([]string, 0, len(channelMembers))
		for memberID := range channelMembers {
			memberIDs = append(memberIDs, memberID)
		}
		sort.Strings(memberIDs)
		for firstIndex := 0; firstIndex < len(memberIDs); firstIndex++ {
			for secondIndex := firstIndex + 1; secondIndex < len(memberIDs); secondIndex++ {
				pair, _ := canonicalVoiceMemberPair(memberIDs[firstIndex], memberIDs[secondIndex])
				pairs[pair] = struct{}{}
			}
		}
	}
	return members, pairs
}
