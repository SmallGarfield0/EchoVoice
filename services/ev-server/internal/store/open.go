package store

import "fmt"

func Open(driver string, sqlitePath string, serverName string) (Store, error) {
	switch driver {
	case "", "sqlite":
		return OpenSQLite(sqlitePath, serverName)
	case "memory":
		return NewMemoryStore(serverName), nil
	default:
		return nil, fmt.Errorf("unsupported storage driver: %s", driver)
	}
}
