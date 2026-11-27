package appstore

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

type InspectDownloadOutput struct {
	URL                string                 `json:"url"`
	MD5                string                 `json:"md5,omitempty"`
	ArtworkURL         string                 `json:"artworkUrl,omitempty"`
	SinfCount          int                    `json:"sinfCount"`
	Metadata           map[string]interface{} `json:"metadata"`
	AvailableVersions  []string               `json:"availableVersions"`
	ExternalVersionID  string                 `json:"externalVersionId"`
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
	guid := strings.ReplaceAll(strings.ToUpper(macAddr), ":", "")
	app := App{ID: appID}

	res, _, err := t.sendDownloadProduct(ctx, acc, app, guid, externalVersionID, PlatformIPhone)
	if err != nil {
		return InspectDownloadOutput{}, err
	}
	if res.Data.FailureType == FailureTypePasswordTokenExpired ||
		res.Data.FailureType == FailureTypeSignInRequired ||
		res.Data.FailureType == FailureTypeDeviceVerificationFailed {
		return InspectDownloadOutput{}, ErrPasswordTokenExpired
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
