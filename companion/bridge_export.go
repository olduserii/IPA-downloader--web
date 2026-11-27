package appstore

import (
	"context"
	"errors"
	"fmt"
)

type InspectDownloadOutput struct {
	URL               string                 `json:"url"`
	MD5               string                 `json:"md5,omitempty"`
	ArtworkURL        string                 `json:"artworkUrl,omitempty"`
	SinfCount         int                    `json:"sinfCount"`
	Metadata          map[string]interface{} `json:"metadata"`
	AvailableVersions []string               `json:"availableVersions"`
	ExternalVersionID string                 `json:"externalVersionId"`
}

func (t *appstore) InspectDownload(
	ctx context.Context,
	acc Account,
	appID int64,
	externalVersionID string,
) (InspectDownloadOutput, error) {
	macAddr, err := t.machine.MacAddress()
	if err != nil {
		return InspectDownloadOutput{}, fmt.Errorf("failed to get mac address: %w", err)
	}
	guid, _, err := machineIdentity(macAddr)
	if err != nil {
		return InspectDownloadOutput{}, fmt.Errorf("failed to resolve machine identity: %w", err)
	}
	app := App{ID: appID}

	res, _, err := t.sendDownloadProduct(ctx, acc, app, guid, externalVersionID, PlatformIPhone)

	// If the account had a wrong/stale pod prefix (e.g. legacy "25") and Apple rejected
	// volumeStoreDownloadProduct with 2034/2042 or empty songList, retry on default host.
	needsPodRetry := acc.Pod != "" && (err != nil ||
		res.Data.FailureType == FailureTypePasswordTokenExpired ||
		res.Data.FailureType == FailureTypeSignInRequired ||
		len(res.Data.Items) == 0)
	if needsPodRetry {
		accNoPod := acc
		accNoPod.Pod = ""
		retryRes, _, retryErr := t.sendDownloadProduct(ctx, accNoPod, app, guid, externalVersionID, PlatformIPhone)
		if retryErr == nil && len(retryRes.Data.Items) > 0 {
			res = retryRes
			err = nil
			acc = accNoPod
		} else if err != nil && retryErr == nil {
			res = retryRes
			err = nil
			acc = accNoPod
		}
	}

	// If volumeStoreDownloadProduct returned 2034/2042/empty for a delisted or account-specific app,
	// also attempt downloaddispatch (redownload + ent/download with kbsync) which does not depend on pod routing.
	needsDelistedFallback := externalVersionID == "" && (err != nil ||
		res.Data.FailureType == FailureTypePasswordTokenExpired ||
		res.Data.FailureType == FailureTypeSignInRequired ||
		len(res.Data.Items) == 0)
	if needsDelistedFallback {
		if bag, bagErr := t.fetchURLBag(guid); bagErr == nil && bag.RedownloadEndpoint != "" {
			if redownload, epErr := newDownloadEndpoint(bag.RedownloadEndpoint, redownloadProductPath); epErr == nil {
				fallbackRes, fallbackErr := t.sendDelistedDownload(ctx, redownload, bag.EntDownloadEndpoint, acc, app, guid)
				if fallbackErr == nil && len(fallbackRes.Data.Items) > 0 {
					res = fallbackRes
					err = nil
				}
			}
		}
	}

	if err != nil {
		return InspectDownloadOutput{}, err
	}
	if res.Data.FailureType == FailureTypePasswordTokenExpired {
		return InspectDownloadOutput{}, fmt.Errorf(
			"%w (apple code=%s, pod=%q, message=%q)",
			ErrPasswordTokenExpired,
			res.Data.FailureType,
			acc.Pod,
			res.Data.CustomerMessage,
		)
	}
	if res.Data.FailureType == FailureTypeLicenseNotFound {
		return InspectDownloadOutput{}, ErrLicenseRequired
	}
	if res.Data.CustomerMessage != "" && (res.Data.FailureType != "" || len(res.Data.Items) == 0) {
		return InspectDownloadOutput{}, NewErrorWithMetadata(fmt.Errorf("apple error: %s", res.Data.CustomerMessage), res)
	}
	if res.Data.FailureType != "" {
		return InspectDownloadOutput{}, NewErrorWithMetadata(fmt.Errorf("apple failure: %s", res.Data.FailureType), res)
	}
	if len(res.Data.Items) == 0 {
		return InspectDownloadOutput{}, errors.New("apple returned empty songList")
	}

	item := res.Data.Items[0]
	var versions []string
	if rawList, ok := item.Metadata["softwareVersionExternalIdentifiers"].([]interface{}); ok {
		for _, v := range rawList {
			versions = append(versions, fmt.Sprintf("%v", v))
		}
	}
	actualVer := ""
	if v, ok := item.Metadata["softwareVersionExternalIdentifier"]; ok {
		actualVer = fmt.Sprintf("%v", v)
	}

	return InspectDownloadOutput{
		URL:               item.URL,
		MD5:               item.HashMD5,
		ArtworkURL:        item.ArtworkURL,
		SinfCount:         len(item.Sinfs),
		Metadata:          item.Metadata,
		AvailableVersions: versions,
		ExternalVersionID: actualVer,
	}, nil
}
