package adminconsole

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/echovoice/echovoice/services/ev-server/internal/store"
	"github.com/echovoice/echovoice/services/ev-server/internal/ws"
)

type Console struct {
	store store.Store
	hub   *ws.Hub
	out   io.Writer
}

func New(appStore store.Store, hub *ws.Hub, out io.Writer) *Console {
	return &Console{store: appStore, hub: hub, out: out}
}

func (c *Console) Run(ctx context.Context, input io.Reader) {
	fmt.Fprintln(c.out, "EchoVoice admin console ready. Type 'help' for commands.")
	scanner := bufio.NewScanner(input)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}
		c.Execute(scanner.Text())
	}
}

func (c *Console) Execute(command string) {
	fields := strings.Fields(strings.TrimSpace(command))
	if len(fields) == 0 {
		return
	}
	switch strings.ToLower(fields[0]) {
	case "help", "?":
		fmt.Fprintln(c.out, "Commands:")
		fmt.Fprintln(c.out, "  members                         List server members and IDs")
		fmt.Fprintln(c.out, "  owner set <member-id>           Transfer server ownership")
		fmt.Fprintln(c.out, "  member link <primary> <other>   Merge another device member into the primary member")
		fmt.Fprintln(c.out, "  server                          Show server identity")
	case "server":
		server := c.store.Server()
		fmt.Fprintf(c.out, "server_id=%s name=%q\n", server.ServerID, server.Name)
	case "members":
		members := c.store.Members()
		if len(members) == 0 {
			fmt.Fprintln(c.out, "No members.")
			return
		}
		serverID := c.store.Server().ServerID
		for _, member := range members {
			fmt.Fprintf(
				c.out,
				"member_id=%s name=%q owner=%t online=%t devices=%d\n",
				member.MemberID,
				member.DisplayName,
				member.IsOwner,
				c.hub.IsMemberOnline(serverID, member.MemberID),
				member.LinkedDevices,
			)
		}
	case "owner":
		if len(fields) != 3 || strings.ToLower(fields[1]) != "set" {
			fmt.Fprintln(c.out, "Usage: owner set <member-id>")
			return
		}
		member, err := c.store.ClaimOwner(fields[2])
		if err != nil {
			fmt.Fprintf(c.out, "owner transfer failed: %v\n", err)
			return
		}
		for _, updated := range c.store.Members() {
			c.hub.Broadcast(ws.Event{Type: "member.updated", Payload: updated})
		}
		fmt.Fprintf(c.out, "owner updated: member_id=%s name=%q\n", member.MemberID, member.DisplayName)
	case "member":
		if len(fields) != 4 || strings.ToLower(fields[1]) != "link" {
			fmt.Fprintln(c.out, "Usage: member link <primary-member-id> <duplicate-member-id>")
			return
		}
		linked, removed, err := c.store.LinkMembers(fields[2], fields[3])
		if err != nil {
			fmt.Fprintf(c.out, "member link failed: %v\n", err)
			return
		}
		c.hub.SendToMember(c.store.Server().ServerID, removed.MemberID, ws.Event{
			Type:    "member.identity_linked",
			Payload: map[string]any{"member": linked, "previous_member_id": removed.MemberID},
		})
		c.hub.Broadcast(ws.Event{Type: "member.left", Payload: removed})
		c.hub.Broadcast(ws.Event{Type: "member.updated", Payload: linked})
		fmt.Fprintf(c.out, "members linked: primary=%s removed=%s devices=%d\n", linked.MemberID, removed.MemberID, linked.LinkedDevices)
	default:
		fmt.Fprintf(c.out, "Unknown command %q. Type 'help'.\n", fields[0])
	}
}
